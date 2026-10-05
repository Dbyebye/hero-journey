const headings = [...document.querySelectorAll('.prose [id^="section-"]')];
const links = [...document.querySelectorAll('[data-toc-link]')];
const drawer = document.querySelector('.toc-drawer');
if (drawer) {
  drawer.addEventListener('click', (event) => {
    if (event.target.closest('a')) drawer.open = false;
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') drawer.open = false;
  });
}

if (headings.length && links.length) {
  let frame = 0;
  const update = () => {
    frame = 0;
    let current = headings[0].id;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= 170) current = heading.id;
      else break;
    }
    for (const link of links) {
      const active = link.hash === `#${current}`;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  window.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });
  window.addEventListener('hashchange', update);
  update();
}
