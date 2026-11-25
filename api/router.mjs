import { createCloudHandler } from '../src/cloud/router.mjs';

// AI 路由要等 Gemini（gemini.mjs 設 45 秒逾時），15 秒不夠；Hobby 方案上限是 300 秒。
export const config = { maxDuration: 60 };

export default createCloudHandler();
