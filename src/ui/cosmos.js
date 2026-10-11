// The star fields behind the page and inside the sidebar.
//
// Stars are painted onto canvases once, and again only when the window is resized or the theme
// changes. Their twinkle, drift and the nebula light around them are CSS animations in
// styles.css, so no script runs per frame. Scrolling only moves one custom property, which
// gives the two star fields a slight parallax.

const STAR_COLOURS = {
  night: [[255, 255, 255], [206, 226, 255], [255, 232, 196], [186, 250, 228]],
  // On the light theme the same sky reads as fine dust in the theme's own inks.
  day: [[40, 122, 104], [176, 132, 46], [104, 96, 190]],
};

// A small repeatable generator (mulberry32), so the sky is the same on every visit.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// `area` is the number of square pixels per star; `haloChance` is the share of stars drawn large
// with a soft glow around them.
function paintStars(canvas, { seed, area, colours, alpha, haloChance }) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 1.25);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  const random = seededRandom(seed);
  const count = Math.round((width * height) / area);
  for (let index = 0; index < count; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const [red, green, blue] = colours[Math.floor(random() * colours.length)];
    const halo = random() < haloChance;
    const radius = halo ? 0.9 + random() * 0.9 : 0.35 + random() * 0.65;
    const strength = alpha * (halo ? 0.7 + random() * 0.3 : 0.3 + random() * 0.7);
    if (halo) {
      const glow = context.createRadialGradient(x, y, 0, x, y, radius * 5);
      glow.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${strength * 0.45})`);
      glow.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);
      context.fillStyle = glow;
      context.beginPath();
      context.arc(x, y, radius * 5, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = `rgba(${red}, ${green}, ${blue}, ${strength})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
}

export function createCosmos({ backdrop, sidebar }) {
  const far = backdrop.querySelector(".cosmos-stars-far");
  const near = backdrop.querySelector(".cosmos-stars-near");
  // The sidebar is dark in both themes, so it always carries a night sky of its own.
  const side = document.createElement("canvas");
  side.className = "sidebar-stars";
  side.setAttribute("aria-hidden", "true");
  sidebar.prepend(side);
  let night = false;

  function paint() {
    const colours = night ? STAR_COLOURS.night : STAR_COLOURS.day;
    paintStars(far, { seed: 11, area: night ? 2600 : 5200, colours, alpha: night ? 0.85 : 0.34, haloChance: 0 });
    paintStars(near, { seed: 29, area: night ? 26000 : 42000, colours, alpha: night ? 1 : 0.5, haloChance: 1 });
    paintStars(side, { seed: 47, area: 2100, colours: STAR_COLOURS.night, alpha: 0.62, haloChance: 0.05 });
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(paint, 180);
  });
  let scrollFrame = 0;
  window.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      backdrop.style.setProperty("--cosmos-scroll", String(Math.min(window.scrollY, 4000)));
    });
  }, { passive: true });

  return {
    setTheme(theme) {
      night = theme === "night";
      paint();
    },
  };
}
