import clickhouse from 'lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from 'lib/db';
import prisma from 'lib/prisma';
import { EVENT_TYPE } from 'lib/constants';
import { QueryFilters } from 'lib/types';

export async function getSessionStats(...args: [websiteId: string, filters: QueryFilters]) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, filters: QueryFilters) {
  const { timezone = 'utc', unit = 'day' } = filters;
  const { getDateSQL, parseFilters, rawQuery } = prisma;
  const { filterQuery, joinSession, params } = await parseFilters(websiteId, {
    ...filters,
    eventType: EVENT_TYPE.pageView,
  });

  return rawQuery(
    `
    select
      ${getDateSQL('website_event.created_at', unit, timezone)} x,
      count(distinct website_event.session_id) y
    from website_event
      ${joinSession}
    where website_event.website_id = {{websiteId::uuid}}
      and website_event.created_at between {{startDate}} and {{endDate}}
      and event_type = {{eventType}}
      ${filterQuery}
    group by 1
    `,
    params,
  );
}

async function clickhouseQuery(
  websiteId: string,
  filters: QueryFilters,
): Promise<{ x: string; y: number }[]> {
  const { timezone = 'UTC', unit = 'day' } = filters;
  const { parseSessionFilters, rawQuery, getDateStringSQL, getDateSQL } = clickhouse;
  const { filterQuery, params } = await parseSessionFilters(websiteId, {
    ...filters,
    eventType: EVENT_TYPE.pageView,
  });

  const table = unit === 'minute' ? 'website_event' : 'website_event_stats_hourly';
  const columnQuery = unit === 'minute' ? 'count(distinct session_id)' : 'uniq(session_id)';

  return rawQuery(
    `
    select
      ${getDateStringSQL('g.t', unit)} as x, 
      g.y as y
    from (
      select 
        ${getDateSQL('created_at', unit, timezone)} as t,
        ${columnQuery} as y
      from ${table} website_event
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        and event_type = {eventType:UInt32}
        ${filterQuery}
      group by t
    ) as g
    order by t
    `,
    params,
  ).then(result => {
    return Object.values(result).map((a: any) => {
      return { x: a.x, y: Number(a.y) };
    });
  });
}
