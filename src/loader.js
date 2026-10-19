// Map data loader. ?map=small|full (default small, falling back to full if small fails to load).
// Data files are classic scripts that set window.PARIS_DATA.
const FILES = { small: 'data/paris-small.js', full: 'data/paris.js' };

export function loadMapData() {
  const want = new URLSearchParams(location.search).get('map') === 'full' ? 'full' : 'small';
  const order = want === 'full' ? [FILES.full] : [FILES.small, FILES.full];
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= order.length) return reject(new Error('Map data missing: ' + order.join(', ') + ' could not be loaded.'));
      const src = order[i++];
      window.PARIS_DATA = undefined;
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => {
        const D = window.PARIS_DATA;
        if (D && D.meta && D.roads && D.buildings) resolve({ data: D, src });
        else { console.warn(`map data ${src} loaded but is invalid, trying the next file`); next(); }
      };
      s.onerror = () => { if (i < order.length) console.info(`map data ${src} not available, falling back`); next(); };
      document.head.appendChild(s);
    };
    next();
  });
}
