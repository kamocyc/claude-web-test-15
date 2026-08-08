import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameTaskCount, registerFrameTask, renderOnce, resetFrameTasks } from './rafLoop';

afterEach(() => resetFrameTasks());

describe('the shared frame loop', () => {
  it('runs registered tasks in `order`, lowest first', () => {
    const seen: string[] = [];
    registerFrameTask('overlay', 20, () => void seen.push('overlay'));
    registerFrameTask('static', 0, () => void seen.push('static'));
    registerFrameTask('dynamic', 10, () => void seen.push('dynamic'));
    renderOnce(0);
    expect(seen).toEqual(['static', 'dynamic', 'overlay']);
  });

  it('unregisters exactly the task it was given', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerFrameTask('a', 0, a);
    registerFrameTask('b', 0, b);
    offA();
    renderOnce(0);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
    expect(frameTaskCount()).toBe(1);
  });

  it('renderOnce is synchronous — this is what makes E2E deterministic', () => {
    let ran = false;
    registerFrameTask('t', 0, () => {
      ran = true;
    });
    renderOnce(0);
    expect(ran).toBe(true);
  });

  it('one throwing task does not stop the others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    registerFrameTask('bad', 0, () => {
      throw new Error('boom');
    });
    registerFrameTask('good', 1, after);
    renderOnce(0);
    expect(after).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a task that unregisters itself mid-frame does not corrupt the pass', () => {
    const later = vi.fn();
    let off: (() => void) | undefined;
    off = registerFrameTask('self', 0, () => off?.());
    registerFrameTask('later', 1, later);
    expect(() => renderOnce(0)).not.toThrow();
    expect(later).toHaveBeenCalledOnce();
    expect(frameTaskCount()).toBe(1);
  });

  it('passes the frame timestamp through', () => {
    const task = vi.fn();
    registerFrameTask('t', 0, task);
    renderOnce(1234);
    expect(task).toHaveBeenCalledWith(1234);
  });
});
