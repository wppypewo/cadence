/** 經人工查證的外部學習資源。只存索引與使用建議，不複製原站內容。 */

import { restRequest } from './supabase.mjs';

export async function listResources(config, auth, fetchImpl = fetch) {
  const select = [
    'level', 'skill', 'title', 'resource_type', 'url', 'source_name',
    'license_note', 'checked_at', 'payload',
  ].join(',');
  const path = `content_resources?active=eq.true&select=${select}&order=level.desc,skill.asc,title.asc`;
  const { data } = await restRequest(config, path, {
    token: auth.token,
    fetchImpl,
  });
  return {
    checkedAt: data.reduce((latest, row) => row.checked_at > latest ? row.checked_at : latest, ''),
    resources: data,
  };
}
