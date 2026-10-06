const themeKey = 'hero-journey-theme';
let savedTheme;
try { savedTheme = localStorage.getItem(themeKey); } catch {}
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';

document.addEventListener('DOMContentLoaded', () => {
  const buttons = [...document.querySelectorAll('[data-theme-toggle]')];
  let switching = false;
  const updateButtons = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const label = dark ? '切换到日间模式' : '切换到夜间模式';
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', label);
      button.querySelector('.rail-tooltip').textContent = label;
    }
  };
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      if (switching) return;
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      const applyTheme = () => {
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem(themeKey, theme); } catch {}
        updateButtons();
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        applyTheme();
        return;
      }

      switching = true;
      buttons.forEach((control) => control.classList.add('is-switching'));
      try {
        if (document.startViewTransition) {
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 2;
          const transition = document.startViewTransition(applyTheme);
          // Skipped transitions (for example in a hidden tab) can reject ready.
          try {
            await transition.ready;
            await document.documentElement.animate(
              { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
              { duration: 560, easing: 'cubic-bezier(.22, 1, .36, 1)', pseudoElement: '::view-transition-new(root)' },
            ).finished;
          } catch {
            transition.skipTransition();
          }
          await transition.finished;
        } else {
          document.documentElement.classList.add('theme-fading');
          applyTheme();
          await new Promise((resolve) => setTimeout(resolve, 260));
        }
      } catch {
        applyTheme();
      } finally {
        document.documentElement.classList.remove('theme-fading');
        buttons.forEach((control) => control.classList.remove('is-switching'));
        switching = false;
      }
    });
  }
  updateButtons();
});
