"use strict"
import {
	produce,
	Immer,
	enableArrayMethods,
	enableMapSet,
	enablePatches,
	current
} from "../src/immer"
import {clearPlugin, PluginArrayMethods} from "../src/internal"

enablePatches()
enableMapSet()

/**
 * Regression tests for:
 * 1. The array-methods plugin treating non-mutating calls to mutating
 *    methods (push() with no args, splice(i, 0), pop()/shift() on an empty
 *    array, sort()/reverse() that leave the order intact) as changes,
 *    breaking structural sharing and emitting spurious patches.
 * 2. Set finalization leaking revoked child proxies / stale draft copies
 *    when a draft was read but not modified (getValue must honor modified_),
 *    and plain (non-draft) Sets holding draft values.
 */
describe("array-methods plugin - no-op mutating methods", () => {
	beforeEach(() => enableArrayMethods())
	afterEach(() => clearPlugin(PluginArrayMethods))

	function produceWithPatches(base, recipe) {
		const immer = new Immer()
		let patches
		const result = immer.produce(base, recipe, p => (patches = p))
		return [result, patches]
	}

	const arrayNoOps = [
		[
			"push() no args",
			{list: [1, 2, 3]},
			d => {
				d.list.push(...[])
			}
		],
		[
			"push() zero args directly",
			{list: [1, 2, 3]},
			d => {
				d.list.push()
			}
		],
		[
			"unshift() no args",
			{list: [1, 2, 3]},
			d => {
				d.list.unshift()
			}
		],
		[
			"splice(i, 0)",
			{list: [1, 2, 3]},
			d => {
				d.list.splice(1, 0)
			}
		],
		[
			"splice(0, 0)",
			{list: [1, 2, 3]},
			d => {
				d.list.splice(0, 0)
			}
		],
		[
			"splice negative start, no delete",
			{list: [1, 2, 3]},
			d => {
				d.list.splice(-1, 0)
			}
		],
		[
			"splice(NaN deleteCount)",
			{list: [1, 2, 3]},
			d => {
				d.list.splice(1, NaN)
			}
		],
		[
			"splice(negative deleteCount)",
			{list: [1, 2, 3]},
			d => {
				d.list.splice(1, -5)
			}
		],
		[
			"pop() on empty",
			{list: []},
			d => {
				d.list.pop()
			}
		],
		[
			"shift() on empty",
			{list: []},
			d => {
				d.list.shift()
			}
		],
		[
			"sort() single element",
			{list: [1]},
			d => {
				d.list.sort()
			}
		],
		[
			"reverse() single element",
			{list: [1]},
			d => {
				d.list.reverse()
			}
		],
		[
			"sort() empty",
			{list: []},
			d => {
				d.list.sort()
			}
		],
		[
			"reverse() empty",
			{list: []},
			d => {
				d.list.reverse()
			}
		],
		[
			"sort() already sorted",
			{list: [1, 2, 3]},
			d => {
				d.list.sort((a, b) => a - b)
			}
		],
		[
			"sort() constant comparator",
			{list: [{a: 1}, {a: 2}]},
			d => {
				d.list.sort(() => 0)
			}
		]
	]

	arrayNoOps.forEach(([name, base, recipe]) => {
		it(`keeps identity for no-op: ${name}`, () => {
			const [result, patches] = produceWithPatches(base, recipe)
			expect(result).toBe(base)
			expect(patches).toEqual([])
		})
	})

	it("reading elements (allocating copy_) does not make sort no-op a change", () => {
		const base = {list: [{a: 1}, {a: 2}]}
		const result = produce(base, d => {
			void d.list[0]
			d.list.sort(() => 0)
		})
		expect(result).toBe(base)
	})

	it("reading elements does not make push() no-op a change", () => {
		const base = {list: [{a: 1}]}
		const result = produce(base, d => {
			void d.list[0]
			d.list.push(...[])
		})
		expect(result).toBe(base)
	})

	it("no-op on nested array still shares that array when a sibling changed", () => {
		const base = {x: 1, list: [1, 2, 3]}
		const result = produce(base, d => {
			d.x = 2
			d.list.push(...[])
		})
		expect(result).not.toBe(base)
		expect(result.list).toBe(base.list)
	})

	it("no-op methods return the draft (chaining) and their native return values", () => {
		produce({list: [1]}, d => {
			expect(d.list.sort()).toBe(d.list)
			expect(d.list.reverse()).toBe(d.list)
		})
		let popped = "untouched"
		produce({list: []}, d => {
			popped = d.list.pop()
		})
		expect(popped).toBeUndefined()
	})

	it("still commits actual changes", () => {
		const base = {list: [3, 1, 2]}
		const [result, patches] = produceWithPatches(base, d => {
			d.list.sort((a, b) => a - b)
		})
		expect(result.list).toEqual([1, 2, 3])
		expect(patches.length).toBeGreaterThan(0)
	})

	it("reorder after a prior modification commits", () => {
		const base = {other: 1, list: [3, 1, 2]}
		const result = produce(base, d => {
			d.other = 2
			d.list.sort((a, b) => a - b)
		})
		expect(result.list).toEqual([1, 2, 3])
		expect(result.other).toBe(2)
	})

	it("sort with drafted objects moved to new positions keeps draft semantics", () => {
		const base = {list: [{a: 2}, {a: 1}]}
		const result = produce(base, d => {
			d.list.sort((x, y) => x.a - y.a)
			d.list[0].a = 99
		})
		expect(result.list.map(x => x.a)).toEqual([99, 2])
		expect(base.list).toEqual([{a: 2}, {a: 1}])
	})

	it("splice negative start inserts at the wrapped index", () => {
		const base = {list: [{x: 1}, {x: 2}]}
		const result = produce(base, d => {
			d.list.splice(-1, 0, {x: 3})
		})
		expect(result.list).toEqual([{x: 1}, {x: 3}, {x: 2}])
	})

	it("splice start beyond negative range inserts at 0", () => {
		const base = {list: [1, 2]}
		const result = produce(base, d => {
			d.list.splice(-100, 0, 9)
		})
		expect(result.list).toEqual([9, 1, 2])
	})

	it("splice insert after a prior push uses the modified length for the index", () => {
		const base = {list: [1, 2]}
		const result = produce(base, d => {
			d.list.push(3, 4, 5)
			d.list.splice(-1, 0, 9)
		})
		expect(result.list).toEqual([1, 2, 3, 4, 9, 5])
	})

	it("splice insert after a prior pop uses the modified length for the index", () => {
		const base = {list: [1, 2, 3, 4, 5]}
		const result = produce(base, d => {
			d.list.pop()
			d.list.splice(-1, 0, 9)
		})
		expect(result.list).toEqual([1, 2, 3, 9, 4])
	})

	it("splice insert with nested draft after prior mutation finalizes the draft", () => {
		const base = {items: [{x: 1}, {x: 2}]}
		const result = produce(base, d => {
			d.items.push({x: 99})
			const child = d.items[0]
			child.x = 10
			d.items.splice(-1, 0, child)
		})
		expect(result.items).toEqual([{x: 10}, {x: 2}, {x: 10}, {x: 99}])
	})

	it("a comparator that throws still propagates", () => {
		const base = {list: [2, 1]}
		expect(() =>
			produce(base, d => {
				d.list.sort(() => {
					throw new Error("boom")
				})
			})
		).toThrow("boom")
	})
})

describe("Set finalization with read-only drafts", () => {
	beforeEach(() => enableArrayMethods())
	afterEach(() => clearPlugin(PluginArrayMethods))

	it("draft Set with added read-only draft array finalizes to base, no duplicates", () => {
		const base = {group: new Set(), items: [{a: 1}, {a: 2}]}
		const result = produce(base, draft => {
			draft.group.add(draft.items)
			void draft.items[1]
		})
		expect(result.group.size).toBe(1)
		const arr = Array.from(result.group)[0]
		expect(arr).toBe(base.items)
		expect(arr).toEqual([{a: 1}, {a: 2}])
	})

	it("draft Set with added modified draft array finalizes to the copy", () => {
		const base = {group: new Set(), items: [{a: 1}]}
		const result = produce(base, draft => {
			void draft.items[0]
			draft.items.push({a: 2})
			draft.group.add(draft.items)
		})
		expect(result.group.size).toBe(1)
		expect(Array.from(result.group)[0]).toEqual([{a: 1}, {a: 2}])
	})

	it("plain Set assigned to a draft replaces draft entries on finalization", () => {
		const base = {items: [{a: 1}]}
		const result = produce(base, draft => {
			void draft.items[0]
			draft.group = new Set([draft.items])
		})
		expect(result.group.size).toBe(1)
		expect(Array.from(result.group)[0]).toBe(base.items)
	})

	it("plain Set nested in a plain assigned object is finalized as well", () => {
		const base = {items: [{a: 1}]}
		const result = produce(base, draft => {
			void draft.items[0]
			draft.extra = {s: new Set([draft.items])}
		})
		expect(Array.from(result.extra.s)[0]).toBe(base.items)
	})

	it("plain Map assigned to a draft holding a draft value is finalized", () => {
		const base = {items: [{a: 1}]}
		const result = produce(base, draft => {
			void draft.items[0]
			draft.map = new Map([["items", draft.items]])
		})
		expect(result.map.get("items")).toBe(base.items)
	})

	it("finalized (and frozen) Set contents never contain revoked proxies", () => {
		const immer = new Immer({autoFreeze: true})
		const base = {items: [{a: 1}]}
		const result = immer.produce(base, draft => {
			void draft.items[0]
			draft.group = new Set([draft.items])
		})
		expect(Object.isFrozen(result.group)).toBe(true)
		const arr = Array.from(result.group)[0]
		expect(() => arr[0].a).not.toThrow()
		expect(arr[0].a).toBe(1)
	})

	it("current() still reflects an unmodified draft with allocated copy", () => {
		produce({list: [{a: 1}]}, d => {
			void d.list[0]
			expect(current(d.list)).toEqual([{a: 1}])
		})
	})
})
