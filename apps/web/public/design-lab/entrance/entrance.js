// Decorative motion only. The two real links work without JavaScript.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const games = [...document.querySelectorAll('.game')];
let pending = 0;

for (const game of games) {
  game.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || !finePointer.matches) return;
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const rect = game.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      game.style.setProperty('--x', `${x * 100}%`);
      game.style.setProperty('--y', `${y * 100}%`);
      game.style.setProperty('--dx', `${(x - .5) * 12}px`);
      game.style.setProperty('--dy', `${(y - .5) * 10}px`);
    });
  });
  game.addEventListener('pointerleave', () => {
    cancelAnimationFrame(pending);
    game.style.setProperty('--dx', '0px');
    game.style.setProperty('--dy', '0px');
  });
}

function resetMotion() {
  if (!reducedMotion.matches && finePointer.matches) return;
  cancelAnimationFrame(pending);
  games.forEach((game) => {
    game.style.removeProperty('--dx');
    game.style.removeProperty('--dy');
  });
}
reducedMotion.addEventListener('change', resetMotion);
finePointer.addEventListener('change', resetMotion);
