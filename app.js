const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(tab) {
  for (const item of tabs) {
    const active = item === tab;
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(item.getAttribute('aria-controls'));
    if (panel) panel.hidden = !active;
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
      : null;
    if (next !== null) {
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    }
  });
});

const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
if (menu && navigation) {
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(open));
    navigation.classList.toggle('open', open);
  });
  navigation.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    menu.setAttribute('aria-expanded', 'false');
    navigation.classList.remove('open');
  }));
}
