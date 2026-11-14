export function renderFixture(nodeCount) {
  const app = document.querySelector('#app');
  const heading = document.createElement('h1');
  heading.textContent = 'Deterministic replay benchmark';
  const navigation = document.createElement('nav');
  navigation.setAttribute('aria-label', 'Fixture views');
  for (const view of ['Overview', 'Activity', 'Settings']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = view;
    button.dataset.view = view.toLowerCase();
    button.addEventListener('click', () => {
      heading.textContent = `${view} · Deterministic replay benchmark`;
      status.textContent = `Viewing ${view.toLowerCase()}`;
      history.pushState({}, '', `#${view.toLowerCase()}`);
    });
    navigation.append(button);
  }
  const input = document.createElement('input');
  input.id = 'benchmark-input';
  input.setAttribute('aria-label', 'Benchmark input');
  const status = document.createElement('p');
  status.id = 'workload-status';
  status.textContent = 'Ready';
  const list = document.createElement('ul');
  list.id = 'workload-list';
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < nodeCount; index++) {
    const row = document.createElement('li');
    row.dataset.row = String(index);
    row.textContent = `Seed 1729 row ${index}`;
    fragment.append(row);
  }
  list.append(fragment);
  app.append(heading, navigation, input, status, list);
}

export function runWorkload(nodeCount) {
  const start = performance.now();
  document.querySelector('[data-view="activity"]').click();
  const input = document.querySelector('#benchmark-input');
  input.value = 'benchmark-value-1729';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  const rows = document.querySelectorAll('#workload-list li');
  const mutations = Math.min(250, Math.max(1, Math.floor(nodeCount * 0.05)));
  for (let index = 0; index < mutations; index++) {
    rows[index].textContent = `Seed 1729 updated row ${index}`;
    rows[index].dataset.updated = 'true';
  }
  const addedRow = document.createElement('li');
  addedRow.textContent = 'Seed 1729 appended row';
  document.querySelector('#workload-list').append(addedRow);
  document.querySelector('[data-view="settings"]').click();
  document.querySelector('[data-view="overview"]').click();
  document.querySelector('#workload-status').textContent = 'Workload complete';
  const syncWorkloadMs = performance.now() - start;

  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        resolve({
          syncWorkloadMs,
          settledWorkloadMs: performance.now() - start,
        }),
      ),
    );
  });
}
