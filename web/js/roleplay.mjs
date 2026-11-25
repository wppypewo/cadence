/**
 * 口說情境對話的題卡，前端用來列選單與顯示題目。
 * 後端 src/cloud/chat.mjs 的 ROLEPLAY_SCENARIOS 是同一份（多了給考官的角色說明），
 * 兩邊各存一份是因為前端不 import src/；tests/ai-chat.test.mjs 會比對兩份，改一邊就要改另一邊。
 * 這個檔案只放資料，不碰 DOM，Node 測試才 import 得進來。
 */

export const ROLEPLAY = [
  {
    id: 'entretien',
    part: 1,
    title: '自我介紹（Partie 1）',
    card: "Entretien dirigé : l'examinateur vous pose des questions sur vous, vos études, vos loisirs, vos projets.",
  },
  {
    id: 'echange',
    part: 2,
    title: '退換壞掉的耳機',
    card: "Vous avez acheté un casque audio il y a une semaine. Il ne fonctionne plus. Vous retournez au magasin pour l'échanger ou être remboursé(e). Le vendeur fait des difficultés.",
  },
  {
    id: 'colocation',
    part: 2,
    title: '跟室友談噪音',
    card: 'Votre colocataire écoute de la musique très fort tard le soir et vous avez un examen la semaine prochaine. Vous lui en parlez pour trouver une solution.',
  },
  {
    id: 'conge',
    part: 2,
    title: '向主管請兩天假',
    card: "Vous travaillez dans une entreprise française. Vous demandez à votre responsable deux jours de congé pour le mariage d'un proche, au moment où l'équipe a beaucoup de travail.",
  },
  {
    id: 'vacances',
    part: 2,
    title: '說服朋友一起去台灣',
    card: 'Votre ami(e) français(e) veut passer les vacances à la plage en France. Vous essayez de le/la convaincre de venir plutôt avec vous à Taïwan.',
  },
  {
    id: 'benevolat',
    part: 2,
    title: '打電話問志工工作',
    card: "Vous voulez faire du bénévolat dans une association d'aide aux personnes âgées. Vous téléphonez pour vous renseigner : missions, horaires, conditions.",
  },
];

/** 按下「結束並講評」時送出的固定句子；後端的系統提示看到這一句才換成中文講評。 */
export const DEBRIEF_TEXT = '結束對話，請講評。';

/** 跟後端的上限一致。前端先擋，免得打了一大段才被伺服器退回。 */
export const MAX_MESSAGE = 4000;
export const MAX_MODEL_MESSAGE = 8000;
