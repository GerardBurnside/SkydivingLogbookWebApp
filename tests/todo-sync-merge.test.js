const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createLocalStorageStub() {
    const store = new Map();
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
        clear() {
            store.clear();
        }
    };
}

function loadSheetsAPIClass() {
    const sheetsJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'sheets.js'), 'utf8');
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        localStorage: createLocalStorageStub(),
        fetch: async () => ({
            ok: false,
            status: 500,
            headers: { get: () => '' },
            text: async () => '',
            json: async () => ({})
        }),
        navigator: { onLine: true },
        document: {
            addEventListener() {},
            getElementById() { return null; }
        }
    };
    sandbox.window = sandbox;
    sandbox.window.AuthManager = {
        ready: Promise.resolve(),
        isSignedIn: () => false,
        getValidToken: async () => 'token',
        silentRefresh: async () => {}
    };
    vm.createContext(sandbox);
    vm.runInContext(`${sheetsJs}\nthis.__SheetsAPIClass = SheetsAPI;`, sandbox);
    return sandbox.__SheetsAPIClass;
}

const SheetsAPI = loadSheetsAPIClass();

function todo(partial) {
    return {
        id: 't1',
        text: 'Pack reserve',
        done: false,
        createdAt: 1000,
        doneAt: null,
        updatedAt: 1000,
        ...partial
    };
}

function idsOf(list) {
    return JSON.parse(JSON.stringify((list || []).map(t => t.id)));
}

test('merge keeps local-only and sheet-only todos', () => {
    const local = [todo({ id: 'local-1', text: 'Local item' })];
    const sheet = [todo({ id: 'sheet-1', text: 'Sheet item' })];
    const merged = SheetsAPI.mergeTodos(local, sheet, []);
    assert.deepEqual(idsOf(merged), ['local-1', 'sheet-1']);
});

test('merge removes a todo deleted on the other device', () => {
    const local = [
        todo({ id: 'keep', text: 'Keep me' }),
        todo({ id: 'gone', text: 'Deleted elsewhere' })
    ];
    const sheet = [todo({ id: 'keep', text: 'Keep me' })];
    const merged = SheetsAPI.mergeTodos(local, sheet, ['gone']);
    assert.deepEqual(idsOf(merged), ['keep']);
});

test('merge last-write-wins on the same todo id', () => {
    const local = [todo({ id: 'same', text: 'Local edit', updatedAt: 5000, done: true, doneAt: 5000 })];
    const sheet = [todo({ id: 'same', text: 'Sheet edit', updatedAt: 2000 })];
    const merged = SheetsAPI.mergeTodos(local, sheet, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].text, 'Local edit');
    assert.equal(merged[0].done, true);
});

test('merge prefers the newer sheet edit over a stale local copy', () => {
    const local = [todo({ id: 'same', text: 'Old local', updatedAt: 1000 })];
    const sheet = [todo({ id: 'same', text: 'New sheet', updatedAt: 9000, done: true, doneAt: 9000 })];
    const merged = SheetsAPI.mergeTodos(local, sheet, []);
    assert.equal(merged[0].text, 'New sheet');
    assert.equal(merged[0].done, true);
});

test('deletion tombstone wins over an item that still exists locally', () => {
    const local = [todo({ id: 'x', text: 'Still here locally', updatedAt: 99999 })];
    const sheet = [todo({ id: 'x', text: 'Still here locally' })];
    const merged = SheetsAPI.mergeTodos(local, sheet, new Set(['x']));
    assert.deepEqual(idsOf(merged), []);
});

test('mergeDeletedTodos unions local and sheet tombstones', () => {
    const merged = SheetsAPI.mergeDeletedTodos(
        [{ id: 'a', deletedAt: '2026-01-01T00:00:00.000Z' }],
        [{ id: 'b', deletedAt: '2026-02-01T00:00:00.000Z' }, { id: 'a', deletedAt: '2026-03-01T00:00:00.000Z' }]
    );
    const ids = idsOf(merged).sort();
    assert.deepEqual(ids, ['a', 'b']);
    const a = merged.find(d => d.id === 'a');
    assert.equal(a.deletedAt, '2026-01-01T00:00:00.000Z');
});

test('logbook records deleted todo ids for later merge', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
    const localStorage = createLocalStorageStub();
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        localStorage,
        navigator: { onLine: false },
        document: {
            addEventListener() {},
            createElement: () => ({ style: {}, click() {} }),
            body: { appendChild() {}, removeChild() {} },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            getElementById() {
                return {
                    addEventListener() {},
                    style: {},
                    classList: { add() {}, remove() {} },
                    value: '',
                    textContent: ''
                };
            }
        }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`${appJs}\nthis.__SkydivingLogbook = SkydivingLogbook;`, sandbox);

    const logbook = Object.create(sandbox.__SkydivingLogbook.prototype);
    logbook.todos = [todo({ id: 'pack' }), todo({ id: 'done-item', done: true, doneAt: 2000, updatedAt: 2000 })];
    logbook.deletedTodos = [];
    logbook._applyingTodoSync = false;
    logbook.currentView = 'jumps';
    logbook.renderTodosList = () => {};
    logbook.closeTodoItemModal = () => {};
    logbook._editingTodoId = 'pack';

    logbook.removeEditingTodo();
    assert.equal(logbook.todos.some(t => t.id === 'pack'), false);
    assert.equal(logbook.deletedTodos.some(d => d.id === 'pack'), true);
    assert.ok(localStorage.getItem('skydiving-deleted-todos').includes('pack'));

    logbook.clearDoneTodos();
    assert.equal(logbook.todos.length, 0);
    assert.equal(logbook.deletedTodos.some(d => d.id === 'done-item'), true);
});
