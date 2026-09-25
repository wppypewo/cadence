/** 本機版的安全預設；部署建置時會在 dist/ 內覆寫成 cloud。 */
globalThis.CADENCE_RUNTIME = Object.freeze({ mode: 'local' });
