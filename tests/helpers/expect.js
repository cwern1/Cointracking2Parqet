// A small expect() on top of node:assert, covering the matchers these tests use.
// It keeps the test suite free of npm dependencies.
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

const ASYMMETRIC = Symbol('asymmetric');

function arrayContaining(expected) {
  return {
    [ASYMMETRIC]: true,
    match: (actual) => Array.isArray(actual) && expected.every((e) => actual.some((a) => equals(a, e))),
    toString: () => `ArrayContaining ${inspect(expected)}`,
  };
}

/** Recursive equality like vitest's toEqual: object keys with undefined values are ignored. */
function equals(a, b) {
  if (b && b[ASYMMETRIC]) return b.match(a);
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => equals(x, b[i]));
  if (a instanceof Map || b instanceof Map) return equals([...a], [...b]);
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = (o) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => equals(a[k], b[k]));
}

/** Like vitest's toMatchObject: every property in `expected` must match, extra properties are fine. */
function matchesObject(actual, expected) {
  if (expected && expected[ASYMMETRIC]) return expected.match(actual);
  if (typeof expected !== 'object' || expected === null) return Object.is(actual, expected);
  if (typeof actual !== 'object' || actual === null) return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
  }
  return Object.keys(expected).every((k) => matchesObject(actual[k], expected[k]));
}

function check(pass, negate, message) {
  if (pass === negate) assert.fail(negate ? `Expected not: ${message}` : message);
}

function matchers(actual, negate) {
  const show = (v) => inspect(v, { depth: 6, breakLength: 120 });
  return {
    toBe: (e) => check(Object.is(actual, e), negate, `${show(actual)} to be ${show(e)}`),
    toEqual: (e) => check(equals(actual, e), negate, `${show(actual)} to equal ${show(e)}`),
    toMatchObject: (e) => check(matchesObject(actual, e), negate, `${show(actual)} to match ${show(e)}`),
    toHaveLength: (n) => check(actual?.length === n, negate, `length ${actual?.length} to be ${n}`),
    toBeNull: () => check(actual === null, negate, `${show(actual)} to be null`),
    toBeGreaterThan: (n) => check(actual > n, negate, `${show(actual)} to be greater than ${n}`),
    toContain: (e) => check(actual.includes(e), negate, `${show(actual)} to contain ${show(e)}`),
    toMatch: (re) =>
      check(typeof re === 'string' ? actual.includes(re) : re.test(actual), negate, `${show(actual)} to match ${re}`),
    toBeInstanceOf: (C) => check(actual instanceof C, negate, `${show(actual)} to be instance of ${C.name}`),
    toThrow: (e) => {
      const msg = actual?.message ?? '';
      const ok = e === undefined || (e instanceof RegExp ? e.test(msg) : msg.includes(e));
      check(ok, negate, `error "${msg}" to match ${e}`);
    },
    toHaveBeenCalled: () => check(actual.calls.length > 0, negate, 'spy to have been called'),
  };
}

export function expect(actual) {
  const m = matchers(actual, false);
  m.not = matchers(actual, true);
  m.rejects = new Proxy(
    {},
    {
      get: (_, name) => async (...args) => {
        let error;
        try {
          await actual;
        } catch (e) {
          error = e;
        }
        if (error === undefined) assert.fail('Expected promise to reject');
        matchers(error, false)[name](...args);
      },
    },
  );
  return m;
}
expect.arrayContaining = arrayContaining;

const stubs = [];
export const vi = {
  spyOn(obj, method) {
    const original = obj[method];
    const spy = (...args) => {
      spy.calls.push(args);
      return original.apply(obj, args);
    };
    spy.calls = [];
    obj[method] = spy;
    stubs.push(() => (obj[method] = original));
    return spy;
  },
  stubGlobal(name, value) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, name);
    const original = globalThis[name];
    globalThis[name] = value;
    stubs.push(() => (had ? (globalThis[name] = original) : delete globalThis[name]));
  },
  unstubAllGlobals() {
    while (stubs.length) stubs.pop()();
  },
};
