(() => {
  const header = document.querySelector('.site-header');
  const year = document.querySelector('#year');
  if (year) year.textContent = String(new Date().getFullYear());
  const updateHeader = () => header?.classList.toggle('scrolled', window.scrollY > 24);
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  const canvas = document.querySelector('.signal-field');
  if (!(canvas instanceof HTMLCanvasElement) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const context = canvas.getContext('2d');
  if (!context) return;

  let width = 0;
  let height = 0;
  let ratio = 1;
  let points = [];
  const pointer = { x: -1000, y: -1000 };

  const reset = () => {
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.min(58, Math.max(26, Math.round(width / 25)));
    points = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.16,
      vy: (Math.random() - 0.5) * 0.16,
      r: Math.random() * 1.2 + 0.5,
    }));
  };

  const render = () => {
    context.clearRect(0, 0, width, height);
    points.forEach((point, index) => {
      point.x += point.vx;
      point.y += point.vy;
      if (point.x < -10) point.x = width + 10;
      if (point.x > width + 10) point.x = -10;
      if (point.y < -10) point.y = height + 10;
      if (point.y > height + 10) point.y = -10;

      const pointerDistance = Math.hypot(point.x - pointer.x, point.y - pointer.y);
      const glow = pointerDistance < 180;
      context.fillStyle = glow ? 'rgba(200,255,69,.82)' : 'rgba(142,162,160,.35)';
      context.beginPath();
      context.arc(point.x, point.y, glow ? point.r + 0.8 : point.r, 0, Math.PI * 2);
      context.fill();

      for (let j = index + 1; j < points.length; j += 1) {
        const other = points[j];
        const distance = Math.hypot(point.x - other.x, point.y - other.y);
        if (distance < 112) {
          context.strokeStyle = `rgba(130,150,148,${(1 - distance / 112) * 0.085})`;
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(point.x, point.y);
          context.lineTo(other.x, other.y);
          context.stroke();
        }
      }
    });
    requestAnimationFrame(render);
  };

  window.addEventListener('resize', reset, { passive: true });
  window.addEventListener('pointermove', (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  }, { passive: true });
  window.addEventListener('pointerleave', () => { pointer.x = -1000; pointer.y = -1000; });
  reset();
  render();
})();
