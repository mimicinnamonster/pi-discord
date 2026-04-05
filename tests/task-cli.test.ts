import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readTasks, filterTasks, sortTasks, Task } from '../src/task-cli';

// ============================================================================
// Setup
// ============================================================================

const TEST_VAULT = '/tmp/test-vault-' + Date.now();

function createTestFile(filename: string, content: string): void {
  const filePath = path.join(TEST_VAULT, filename);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content);
}

beforeAll(() => {
  if (!fs.existsSync(TEST_VAULT)) {
    fs.mkdirSync(TEST_VAULT, { recursive: true });
  }
});

afterAll(() => {
  if (fs.existsSync(TEST_VAULT)) {
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
  }
});

// ============================================================================
// Tests
// ============================================================================

describe('Task Parsing', () => {
  it('should parse basic inline tasks', () => {
    createTestFile('test1.md', `
# Tasks

- [ ] Basic task
- [x] Completed task
- [/] In progress task
- [!] On hold task
- [>] Planned task
- [-] Cancelled task
`);

    const tasks = readTasks(TEST_VAULT);

    expect(tasks).toHaveLength(6);
    expect(tasks[0]).toMatchObject({
      title: 'Basic task',
      status: 'todo',
    });
    expect(tasks[1]).toMatchObject({
      title: 'Completed task',
      status: 'done',
    });
    expect(tasks[2]).toMatchObject({
      title: 'In progress task',
      status: 'in-progress',
    });
  });

  it('should parse task with priority', () => {
    createTestFile('priorities.md', `
- [ ] Highest priority ⏫
- [ ] High priority ⏫
- [ ] Medium priority 🔼
- [ ] Low priority 🔽
- [ ] Lowest priority ⏬
`);

    const tasks = readTasks(TEST_VAULT);
    const priorityTasks = tasks.filter((t) => t.filePath.includes('priorities.md'));

    expect(priorityTasks[0]).toMatchObject({ priority: 'high' });
    expect(priorityTasks[2]).toMatchObject({ priority: 'medium' });
    expect(priorityTasks[4]).toMatchObject({ priority: 'lowest' });
  });

  it('should parse task with dates', () => {
    createTestFile('dates.md', `
- [ ] Task with due date 📅 2024-12-31
- [ ] Task with time ⏰ 14:30
- [ ] Task with scheduled date ⏳ 2024-01-15
- [ ] Task with start date 🛫 2024-01-01
`);

    const tasks = readTasks(TEST_VAULT);
    const dateTasks = tasks.filter((t) => t.filePath.includes('dates.md'));

    expect(dateTasks[0]).toMatchObject({ dueDate: '2024-12-31' });
    expect(dateTasks[1]).toMatchObject({ dueTime: '14:30' });
    expect(dateTasks[2]).toMatchObject({ scheduledDate: '2024-01-15' });
    expect(dateTasks[3]).toMatchObject({ startDate: '2024-01-01' });
  });

  it('should parse task with tags', () => {
    createTestFile('tags.md', `
- [ ] Work task #work #urgent
- [ ] Personal task #personal #hobby
- [ ] Project task #project/alpha #important
`);

    const tasks = readTasks(TEST_VAULT);
    const tagTasks = tasks.filter((t) => t.filePath.includes('tags.md'));

    expect(tagTasks[0]).toMatchObject({ tags: ['work', 'urgent'] });
    expect(tagTasks[1]).toMatchObject({ tags: ['personal', 'hobby'] });
    expect(tagTasks[2]).toMatchObject({ tags: ['project/alpha', 'important'] });
  });

  it('should parse task with recurrence', () => {
    createTestFile('recurring.md', `
- [ ] Weekly review 🔁 every week 📅 2024-12-31
- [ ] Daily standup 🔁 every day
`);

    const tasks = readTasks(TEST_VAULT);
    const recurringTasks = tasks.filter((t) => t.filePath.includes('recurring.md'));

    expect(recurringTasks[0]).toMatchObject({
      recurrence: 'every week',
      dueDate: '2024-12-31',
    });
    expect(recurringTasks[1]).toMatchObject({
      recurrence: 'every day',
    });
  });

  it('should parse complex task with multiple attributes', () => {
    createTestFile('complex.md', `
- [ ] Complex task ⏫ 📅 2024-12-25 ⏰ 14:30 #work #important
`);

    const tasks = readTasks(TEST_VAULT);
    const complexTask = tasks.find((t) => t.filePath.includes('complex.md'));

    expect(complexTask).toMatchObject({
      title: 'Complex task',
      status: 'todo',
      priority: 'high',
      dueDate: '2024-12-25',
      dueTime: '14:30',
      tags: ['work', 'important'],
    });
  });
});

describe('Task Filtering', () => {
  it('should filter by status', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Todo', status: 'todo', filePath: '', tags: [] },
      { id: '2', title: 'Done', status: 'done', filePath: '', tags: [] },
      { id: '3', title: 'In Progress', status: 'in-progress', filePath: '', tags: [] },
    ];

    const filtered = filterTasks(tasks, { status: ['done', 'in-progress'] });

    expect(filtered).toHaveLength(2);
    expect(filtered[0].status).toBe('done');
    expect(filtered[1].status).toBe('in-progress');
  });

  it('should filter by priority', () => {
    const tasks: Task[] = [
      { id: '1', title: 'High', status: 'todo', priority: 'high', filePath: '', tags: [] },
      { id: '2', title: 'Low', status: 'todo', priority: 'low', filePath: '', tags: [] },
      { id: '3', title: 'Medium', status: 'todo', priority: 'medium', filePath: '', tags: [] },
    ];

    const filtered = filterTasks(tasks, { priority: ['high', 'medium'] });

    expect(filtered).toHaveLength(2);
    expect(filtered[0].priority).toBe('high');
    expect(filtered[1].priority).toBe('medium');
  });

  it('should filter by tags (include)', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Work task', status: 'todo', filePath: '', tags: ['work', 'urgent'] },
      { id: '2', title: 'Personal', status: 'todo', filePath: '', tags: ['personal'] },
      { id: '3', title: 'Another work', status: 'todo', filePath: '', tags: ['work'] },
    ];

    const filtered = filterTasks(tasks, { tags: { include: ['work'] } });

    expect(filtered).toHaveLength(2);
    expect(filtered.every((t) => t.tags.some((tag) => tag.includes('work')))).toBe(true);
  });

  it('should filter by tags (exclude)', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Work task', status: 'todo', filePath: '', tags: ['work'] },
      { id: '2', title: 'Personal', status: 'todo', filePath: '', tags: ['personal'] },
      { id: '3', title: 'Another work', status: 'todo', filePath: '', tags: ['work', 'urgent'] },
    ];

    const filtered = filterTasks(tasks, { tags: { exclude: ['work'] } });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('Personal');
  });

  it('should filter by due date range', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Task 1', status: 'todo', dueDate: '2024-01-01', filePath: '', tags: [] },
      { id: '2', title: 'Task 2', status: 'todo', dueDate: '2024-06-15', filePath: '', tags: [] },
      { id: '3', title: 'Task 3', status: 'todo', dueDate: '2024-12-31', filePath: '', tags: [] },
    ];

    const filtered = filterTasks(tasks, {
      dueAfter: '2024-01-01',
      dueBefore: '2024-12-31',
    });

    expect(filtered).toHaveLength(3);
  });

  it('should filter by text search', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Buy groceries', status: 'todo', filePath: '', tags: [] },
      { id: '2', title: 'Write report', status: 'todo', filePath: '', tags: [] },
      { id: '3', title: 'Call grocery store', status: 'todo', filePath: '', tags: [] },
    ];

    const filtered = filterTasks(tasks, { text: 'grocery' });

    expect(filtered).toHaveLength(2);
    expect(filtered.every((t) => t.title.toLowerCase().includes('grocery'))).toBe(true);
  });

  it('should filter by file path', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Task 1', status: 'todo', filePath: '/vault/work/tasks.md', tags: [] },
      { id: '2', title: 'Task 2', status: 'todo', filePath: '/vault/personal/tasks.md', tags: [] },
      { id: '3', title: 'Task 3', status: 'todo', filePath: '/vault/work/projects.md', tags: [] },
    ];

    const filtered = filterTasks(tasks, { files: ['work'] });

    expect(filtered).toHaveLength(2);
    expect(filtered.every((t) => t.filePath.includes('work'))).toBe(true);
  });
});

describe('Task Sorting', () => {
  it('should sort by due date ascending', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Task 1', status: 'todo', dueDate: '2024-12-31', filePath: '', tags: [] },
      { id: '2', title: 'Task 2', status: 'todo', dueDate: '2024-01-01', filePath: '', tags: [] },
      { id: '3', title: 'Task 3', status: 'todo', dueDate: '2024-06-15', filePath: '', tags: [] },
    ];

    const sorted = sortTasks(tasks, { field: 'dueDate', order: 'asc' });

    expect(sorted[0].dueDate).toBe('2024-01-01');
    expect(sorted[1].dueDate).toBe('2024-06-15');
    expect(sorted[2].dueDate).toBe('2024-12-31');
  });

  it('should sort by priority descending', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Low', status: 'todo', priority: 'low', filePath: '', tags: [] },
      { id: '2', title: 'Highest', status: 'todo', priority: 'highest', filePath: '', tags: [] },
      { id: '3', title: 'Medium', status: 'todo', priority: 'medium', filePath: '', tags: [] },
    ];

    const sorted = sortTasks(tasks, { field: 'priority', order: 'desc' });

    expect(sorted[0].priority).toBe('highest');
    expect(sorted[1].priority).toBe('medium');
    expect(sorted[2].priority).toBe('low');
  });

  it('should sort by title', () => {
    const tasks: Task[] = [
      { id: '1', title: 'Zebra task', status: 'todo', filePath: '', tags: [] },
      { id: '2', title: 'Apple task', status: 'todo', filePath: '', tags: [] },
      { id: '3', title: 'Banana task', status: 'todo', filePath: '', tags: [] },
    ];

    const sorted = sortTasks(tasks, { field: 'title', order: 'asc' });

    expect(sorted[0].title).toBe('Apple task');
    expect(sorted[1].title).toBe('Banana task');
    expect(sorted[2].title).toBe('Zebra task');
  });

  it('should handle multiple sort criteria', () => {
    const tasks: Task[] = [
      { id: '1', title: 'B', status: 'todo', priority: 'high', filePath: '', tags: [] },
      { id: '2', title: 'A', status: 'todo', priority: 'low', filePath: '', tags: [] },
      { id: '3', title: 'A', status: 'todo', priority: 'high', filePath: '', tags: [] },
    ];

    const sorted = sortTasks(tasks, [
      { field: 'priority', order: 'desc' },
      { field: 'title', order: 'asc' },
    ]);

    expect(sorted[0]).toMatchObject({ title: 'A', priority: 'high' });
    expect(sorted[1]).toMatchObject({ title: 'B', priority: 'high' });
    expect(sorted[2]).toMatchObject({ title: 'A', priority: 'low' });
  });
});

describe('Integration', () => {
  it('should read, filter, and sort tasks together', () => {
    createTestFile(
      'integration.md',
      `
- [ ] Buy groceries ⏫ 📅 2024-12-31 #personal
- [x] Write report #work
- [ ] Call meeting ⏫ 📅 2024-01-15 #work
- [ ] Review PR 📅 2024-06-15 #work
`,
    );

    let tasks = readTasks(TEST_VAULT);
    tasks = tasks.filter((t) => t.filePath.includes('integration.md'));

    // Filter: only work tasks that are not done
    tasks = filterTasks(tasks, { status: ['todo'], tags: { include: ['work'] } });

    // Sort by due date ascending
    tasks = sortTasks(tasks, { field: 'dueDate', order: 'asc' });

    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe('Call meeting');
    expect(tasks[1].title).toBe('Review PR');
  });
});
