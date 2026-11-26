export function renderFixture(rows) {
  const app = document.querySelector('#app');
  app.innerHTML = `
    <h1>Faro replay fixture</h1>
    <button id="run-workload">Update rows</button>
    <p id="workload-status">Ready</p>
    <label>Private input <input type="password" value="synthetic-private-1729"></label>
    <ul id="workload-list"></ul>
  `;
  const list = app.querySelector('ul');
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < rows; index++) {
    const row = document.createElement('li');
    row.textContent = 'Seed 1729 row ' + index;
    fragment.append(row);
  }
  list.append(fragment);
}

export function runWorkload(rows) {
  const list = document.querySelector('#workload-list');
  const count = Math.min(250, Math.floor(rows * 0.05));
  for (let index = 0; index < count; index++) {
    list.children[index].textContent = 'Seed 1729 updated row ' + index;
  }
  const addedRow = document.createElement('li');
  addedRow.id = 'appended-row';
  addedRow.textContent = 'Seed 1729 appended row';
  list.append(addedRow);
  document.querySelector('#workload-status').textContent = 'Workload complete';
}
