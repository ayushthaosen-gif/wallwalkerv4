// WMATA Data Loader — merges route chunks once both parts are loaded
(function() {
  function tryMerge() {
    if (typeof window._WMATA_ROUTES_P1 !== 'undefined' &&
        typeof window._WMATA_ROUTES_P2 !== 'undefined') {
      window.WMATA_BUS_ROUTES = Object.assign({}, window._WMATA_ROUTES_P1, window._WMATA_ROUTES_P2);
      delete window._WMATA_ROUTES_P1;
      delete window._WMATA_ROUTES_P2;
      console.log('WMATA routes merged:', Object.keys(window.WMATA_BUS_ROUTES).length, 'routes');
    }
  }
  // Try immediately, then poll
  tryMerge();
  if (!window.WMATA_BUS_ROUTES) {
    const t = setInterval(() => { tryMerge(); if (window.WMATA_BUS_ROUTES) clearInterval(t); }, 200);
  }
})();
