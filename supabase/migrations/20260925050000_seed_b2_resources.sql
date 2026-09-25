-- 只存經人工查證的資源索引；內容仍留在原站，避免版權與過期副本問題。
with owner as (
  -- cadence 只允許唯一擁有者；若資料庫沒有使用者或出現多位使用者，就安全地不寫入。
  select id from auth.users
  where (select count(*) from auth.users) = 1
  limit 1
), resources(level, skill, title, resource_type, url, source_name, license_note, checked_at, payload) as (
  values
    ('B2', 'CE', 'DELF B2 官方考試頁', 'official-exam',
      'https://www.france-education-international.fr/en/diplome/delf-tout-public/niveau-b2',
      'France Éducation international', '免費連結，內容權利屬原站', date '2026-09-25',
      '{"description":"考試格式、評分門檻、樣題與各科說明的官方入口。先用它確認目標，再安排練習。","bestFor":"第一次規劃 B2，或模考前核對題型","cadence":"起步看一次；每次模考前再核對","format":"官方說明與樣題","skills":["CE","CO","PE","PO"],"featured":true,"free":true}'::jsonb),
    ('B2', 'CO', 'B2 avancé 練習庫', 'video-exercises',
      'https://apprendre.tv5monde.com/fr/exercices/b2-avance',
      'TV5MONDE', '免費連結，內容權利屬原站', date '2026-09-25',
      '{"description":"以新聞、訪談與文化影片做進階理解練習；可反覆聽，適合把真實語速拆開。","bestFor":"聽懂主旨、立場與細節","cadence":"每週 2 次，每次完成 1 組","format":"影片、逐題練習與回饋","skills":["CO","CE"],"featured":true,"free":true}'::jsonb),
    ('B2', 'CO', 'Journal en français facile', 'news-podcast',
      'https://francaisfacile.rfi.fr/fr/podcasts/journal-en-fran%C3%A7ais-facile/',
      'RFI', '免費連結，內容權利屬原站', date '2026-09-25',
      '{"description":"約十分鐘的每日國際新聞，附文字稿與部分練習。先盲聽，再對稿找漏掉的訊息。","bestFor":"真實語速、新聞詞彙與摘要能力","cadence":"平日選 2 天：盲聽一次、對稿一次、口頭摘要","format":"音訊、文字稿與練習","skills":["CO","PO"],"featured":false,"free":true}'::jsonb),
    ('B2', 'PO', 'DELF B2 考生手冊', 'official-manual',
      'https://www.france-education-international.fr/document/manuel-candidat-delf-B2',
      'France Éducation international', '免費 PDF，內容權利屬原站', date '2026-09-25',
      '{"description":"官方考生手冊，集中說明流程、任務與評量方式。練口說和寫作前先讀對應頁。","bestFor":"理解評分者要看什麼，避免只練語法","cadence":"開始 B2 時完整讀一次；每月複查弱科","format":"官方 PDF 手冊","skills":["CE","CO","PE","PO"],"featured":false,"free":true}'::jsonb),
    ('B2', 'CE', 'CEFR 自我評量表', 'self-assessment',
      'https://www.coe.int/fr/web/portfolio/self-assessment-grid',
      'Council of Europe', '免費連結，內容權利屬原站', date '2026-09-25',
      '{"description":"用歐洲共同語言參考架構的能力描述檢查自己能做什麼，不用題數假裝等級。","bestFor":"每月校準四科能力與設定下一個練習重點","cadence":"每四週填一次，只記具體證據","format":"官方能力描述量表","skills":["CE","CO","PE","PO"],"featured":false,"free":true}'::jsonb),
    ('B2', 'PE', 'DELF–DALF B2 精選資源', 'curated-collection',
      'https://arts.ucalgary.ca/languages-linguistics-literatures-cultures/french-centre/repsit/delf-dalf',
      'University of Calgary French Centre', '免費連結，內容權利屬各原站', date '2026-09-25',
      '{"description":"大學法語中心整理的 B2 寫作、口說與理解資源，可在官方樣題之外補足練習量。","bestFor":"找特定科目的第二份練習材料","cadence":"弱科材料不足時再取用，不必全部做完","format":"大學策展連結集","skills":["CE","CO","PE","PO"],"featured":false,"free":true}'::jsonb)
)
insert into public.content_resources (
  owner_id, level, skill, title, resource_type, url, source_name, license_note, checked_at, payload
)
select owner.id, r.level, r.skill, r.title, r.resource_type, r.url, r.source_name,
       r.license_note, r.checked_at, r.payload
from owner cross join resources r
where not exists (
  select 1 from public.content_resources existing
  where existing.owner_id = owner.id and existing.url = r.url
);
