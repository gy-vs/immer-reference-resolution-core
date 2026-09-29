import {
	PluginArrayMethods,
	latest,
	loadPlugin,
	markChanged,
	prepareCopy,
	handleCrossReference,
	ProxyArrayState,
	DRAFT_STATE
} from "../internal"

/**
 * Methods that directly modify the array in place.
 * These operate on the copy without creating per-element proxies:
 * - `push`, `pop`: Add/remove from end
 * - `shift`, `unshift`: Add/remove from start (marks all indices reassigned)
 * - `splice`: Add/remove at arbitrary position (marks all indices reassigned)
 * - `reverse`, `sort`: Reorder elements (marks all indices reassigned)
 */
type MutatingArrayMethod =
	| "push"
	| "pop"
	| "shift"
	| "unshift"
	| "splice"
	| "reverse"
	| "sort"

/**
 * Methods that read from the array without modifying it.
 * These fall into distinct categories based on return semantics:
 *
 * **Subset operations** (return drafts - mutations propagate):
 * - `filter`, `slice`: Return array of draft proxies
 * - `find`, `findLast`: Return single draft proxy or undefined
 *
 * **Transform operations** (return base values - mutations don't track):
 * - `concat`, `flat`: Create new structures, not subsets of original
 *
 * **Primitive-returning** (no draft needed):
 * - `findIndex`, `findLastIndex`, `indexOf`, `lastIndexOf`: Return numbers
 * - `some`, `every`, `includes`: Return booleans
 * - `join`, `toString`, `toLocaleString`: Return strings
 */
type NonMutatingArrayMethod =
	| "filter"
	| "slice"
	| "concat"
	| "flat"
	| "find"
	| "findIndex"
	| "findLast"
	| "findLastIndex"
	| "some"
	| "every"
	| "indexOf"
	| "lastIndexOf"
	| "includes"
	| "join"
	| "toString"
	| "toLocaleString"

/** Union of all array operation methods handled by the plugin. */
export type ArrayOperationMethod = MutatingArrayMethod | NonMutatingArrayMethod

/**
 * Enables optimized array method handling for Immer drafts.
 *
 * This plugin overrides array methods to avoid unnecessary Proxy creation during iteration,
 * significantly improving performance for array-heavy operations.
 *
 * **Mutating methods** (push, pop, shift, unshift, splice, sort, reverse):
 * Operate directly on the copy without creating per-element proxies.
 *
 * **Non-mutating methods** fall into categories:
 * - **Subset operations** (filter, slice, find, findLast): Return draft proxies - mutations track
 * - **Transform operations** (concat, flat): Return base values - mutations don't track
 * - **Primitive-returning** (indexOf, includes, some, every, etc.): Return primitives
 *
 * **Important**: Callbacks for overridden methods receive base values, not drafts.
 * This is the core performance optimization.
 *
 * @example
 * ```ts
 * import { enableArrayMethods, produce } from "immer"
 *
 * enableArrayMethods()
 *
 * const next = produce(state, draft => {
 *   // Optimized - no proxy creation per element
 *   draft.items.sort((a, b) => a.value - b.value)
 *
 *   // filter returns drafts - mutations propagate
 *   const filtered = draft.items.filter(x => x.value > 5)
 *   filtered[0].value = 999 // Affects draft.items[originalIndex]
 * })
 * ```
 *
 * @see https://immerjs.github.io/immer/array-methods
 */
export function enableArrayMethods() {
	const SHIFTING_METHODS = new Set<MutatingArrayMethod>(["shift", "unshift"])

	const QUEUE_METHODS = new Set<MutatingArrayMethod>(["push", "pop"])

	const RESULT_RETURNING_METHODS = new Set<MutatingArrayMethod>([
		...QUEUE_METHODS,
		...SHIFTING_METHODS
	])

	const REORDERING_METHODS = new Set<MutatingArrayMethod>(["reverse", "sort"])

	// Optimized method detection using array-based lookup
	const MUTATING_METHODS = new Set<MutatingArrayMethod>([
		...RESULT_RETURNING_METHODS,
		...REORDERING_METHODS,
		"splice"
	])

	const FIND_METHODS = new Set<NonMutatingArrayMethod>(["find", "findLast"])

	const NON_MUTATING_METHODS = new Set<NonMutatingArrayMethod>([
		"filter",
		"slice",
		"concat",
		"flat",
		...FIND_METHODS,
		"findIndex",
		"findLastIndex",
		"some",
		"every",
		"indexOf",
		"lastIndexOf",
		"includes",
		"join",
		"toString",
		"toLocaleString"
	])

	// Type guard for method detection
	function isMutatingArrayMethod(
		method: string
	): method is MutatingArrayMethod {
		return MUTATING_METHODS.has(method as any)
	}

	function isNonMutatingArrayMethod(
		method: string
	): method is NonMutatingArrayMethod {
		return NON_MUTATING_METHODS.has(method as any)
	}

	function isArrayOperationMethod(
		method: string
	): method is ArrayOperationMethod {
		return isMutatingArrayMethod(method) || isNonMutatingArrayMethod(method)
	}

	function enterOperation(
		state: ProxyArrayState,
		method: ArrayOperationMethod
	) {
		state.operationMethod = method
	}

	function exitOperation(state: ProxyArrayState) {
		state.operationMethod = undefined
	}

	// Shared utility functions for array method handlers
	function executeArrayMethod<T>(
		state: ProxyArrayState,
		operation: () => T
	): T {
		prepareCopy(state)
		const result = operation()
		markChanged(state)
		state.assigned_!.set("length", true)
		return result
	}

	/**
	 * Compares a copy element against its base counterpart for identity,
	 * treating a draft as equivalent to the base it was (still) drafted from.
	 *
	 * Reordering methods run on the raw copy, so unmodified slots hold raw
	 * base references, while slots touched through the draft may hold child
	 * draft proxies. Either way the logical value is unchanged, so this keeps
	 * a no-op `sort`/`reverse` observable as a no-op, matching the behavior of
	 * running those methods directly against an Immer draft without this plugin.
	 */
	function isSameSlotValue(baseValue: any, copyValue: any) {
		if (baseValue === copyValue) return true
		const childState = copyValue?.[DRAFT_STATE]
		return !!childState && childState.base_ === baseValue
	}

	/**
	 * Returns true when `copy_` is element-for-element identical to `base_`,
	 * i.e. a mutating operation didn't actually change any value. Lengths are
	 * expected to be equal by the callers that need this check.
	 */
	function copyEqualsBase(state: ProxyArrayState) {
		const {base_, copy_} = state
		for (let i = 0; i < base_.length; i++) {
			if (!isSameSlotValue(base_[i], copy_![i])) return false
		}
		return true
	}

	function markAllIndicesReassigned(state: ProxyArrayState) {
		state.allIndicesReassigned_ = true
		state.baseRefs_ = new Set(state.base_)
	}

	function normalizeSliceIndex(index: number, length: number): number {
		if (index < 0) {
			return Math.max(length + index, 0)
		}
		return Math.min(index, length)
	}

	/**
	 * Normalizes the `start` argument of `Array.prototype.splice`, which wraps
	 * negative offsets from the end (unlike slice) and clamps the result into
	 * [0, length]. Non-numbers follow the spec's ToIntegerOrInfinity rules
	 * (`undefined` becomes 0, `NaN` becomes 0).
	 */
	function normalizeSpliceStart(rawStart: number | undefined, length: number) {
		const start = rawStart === undefined ? 0 : Math.trunc(rawStart)
		if (Number.isNaN(start)) return 0
		return start < 0 ? Math.max(length + start, 0) : Math.min(start, length)
	}

	/**
	 * Normalizes the `deleteCount` argument of `Array.prototype.splice`,
	 * clamped to [0, length - start]. Non-numbers follow the spec
	 * (`undefined` deletes the rest, `NaN` deletes nothing).
	 */
	function normalizeSpliceDeleteCount(
		rawDeleteCount: number | undefined,
		length: number,
		start: number
	) {
		if (rawDeleteCount === undefined) return length - start
		const deleteCount = Math.trunc(rawDeleteCount)
		if (Number.isNaN(deleteCount) || deleteCount <= 0) return 0
		return Math.min(deleteCount, length - start)
	}

	/**
	 * Calls handleCrossReference for each value being inserted into the array,
	 * and marks the corresponding indices as assigned in `assigned_`.
	 *
	 * This ensures nested drafts inside inserted values (e.g. from spreading
	 * a draft object) are properly finalized, matching the behavior of the
	 * proxy set trap which calls handleCrossReference on every assignment.
	 *
	 * Without this, values containing draft proxies (like `{...state[0]}`)
	 * pushed via the array methods plugin would have their nested drafts
	 * revoked during finalization without being replaced by final values.
	 *
	 * The index is stringified because the proxy traps only ever see property
	 * names, so `assigned_` is keyed by string everywhere else. A numeric key
	 * would be invisible to the readers that look indices up by name, such as
	 * patch generation.
	 */
	function handleInsertedValues(
		state: ProxyArrayState,
		startIndex: number,
		values: any[]
	) {
		for (let i = 0; i < values.length; i++) {
			const index = "" + (startIndex + i)
			state.assigned_!.set(index, true)
			handleCrossReference(state, index, values[i])
		}
	}

	/**
	 * Handles mutating operations that add/remove elements (push, pop, shift, unshift, splice).
	 *
	 * Operates directly on `state.copy_` without creating per-element proxies.
	 * For shifting methods (shift, unshift), marks all indices as reassigned since
	 * indices shift.
	 *
	 * Operations that provably leave the array unchanged (`push()` / `unshift()`
	 * without arguments, `pop()` / `shift()` on an empty array) are treated as
	 * no-ops: the draft is neither copied nor marked changed, so structural
	 * sharing is preserved exactly like running these methods without the
	 * array-methods plugin.
	 *
	 * @returns For push/pop/shift/unshift: the native method result. For others: the draft.
	 */
	function handleSimpleOperation(
		state: ProxyArrayState,
		method: string,
		args: any[]
	) {
		// Fast no-ops: on an unmodified draft these methods don't touch the
		// array at all, so we must not allocate a copy or mark it changed.
		if (!state.modified_) {
			const length = state.base_.length
			if (args.length === 0 && (method === "push" || method === "unshift")) {
				return length
			}
			if (length === 0 && (method === "pop" || method === "shift")) {
				return undefined
			}
		}

		return executeArrayMethod(state, () => {
			// For push/unshift, capture the length before the operation
			// so we can compute insertion indices for handleCrossReference
			const lengthBefore = state.copy_!.length

			const result = (state.copy_! as any)[method](...args)

			// Handle index reassignment for shifting methods
			if (SHIFTING_METHODS.has(method as MutatingArrayMethod)) {
				markAllIndicesReassigned(state)
			}

			// Handle cross-references for newly inserted values.
			// push appends at the end, unshift inserts at the beginning.
			if (method === "push" && args.length > 0) {
				handleInsertedValues(state, lengthBefore, args)
			} else if (method === "unshift" && args.length > 0) {
				handleInsertedValues(state, 0, args)
			}

			// Return appropriate value based on method
			return RESULT_RETURNING_METHODS.has(method as MutatingArrayMethod)
				? result
				: state.draft_
		})
	}

	/**
	 * Handles reordering operations (reverse, sort) that change element order.
	 *
	 * Operates directly on `state.copy_` and marks all indices as reassigned
	 * since element positions change. Does not mark length as changed since
	 * these operations preserve array length.
	 *
	 * If running the method leaves the elements in the same order (e.g.
	 * `reverse()` on a 0/1 element array, or a `sort()` that compares every
	 * pair as equal), the operation is a no-op and the draft is left
	 * unmodified, preserving structural sharing with the base state.
	 *
	 * @returns The draft proxy for method chaining.
	 */
	function handleReorderingOperation(
		state: ProxyArrayState,
		method: string,
		args: any[]
	) {
		// No ordering can change with fewer than two elements, and neither
		// method mutates an array that short natively either.
		if (!state.modified_ && state.base_.length < 2) return state.draft_

		prepareCopy(state)
		;(state.copy_! as any)[method](...args)

		if (!state.modified_) {
			// The method might still have reordered nothing (stable sort with
			// an equal comparator); verify before committing the change.
			if (copyEqualsBase(state)) return state.draft_
		}

		markChanged(state)
		markAllIndicesReassigned(state)
		return state.draft_
	}

	/**
	 * Creates an interceptor function for a specific array method.
	 *
	 * The interceptor wraps array method calls to:
	 * 1. Set `state.operationMethod` flag during execution (allows proxy `get` trap
	 *    to detect we're inside an optimized method and skip proxy creation)
	 * 2. Route to appropriate handler based on method type
	 * 3. Clean up the operation flag in `finally` block
	 *
	 * The `operationMethod` flag is the key mechanism that enables the proxy's `get`
	 * trap to return base values instead of creating nested proxies during iteration.
	 *
	 * @param state - The proxy array state
	 * @param originalMethod - Name of the array method being intercepted
	 * @returns Interceptor function that handles the method call
	 */
	function createMethodInterceptor(
		state: ProxyArrayState,
		originalMethod: string
	) {
		return function interceptedMethod(...args: any[]) {
			// Enter operation mode - this flag tells the proxy's get trap to return
			// base values instead of creating nested proxies during iteration
			const method = originalMethod as ArrayOperationMethod
			enterOperation(state, method)

			try {
				// Check if this is a mutating method
				if (isMutatingArrayMethod(method)) {
					// Direct method dispatch - no configuration lookup needed
					if (RESULT_RETURNING_METHODS.has(method)) {
						return handleSimpleOperation(state, method, args)
					}
					if (REORDERING_METHODS.has(method)) {
						return handleReorderingOperation(state, method, args)
					}

					if (method === "splice") {
						// Detect no-op splices (nothing removed and nothing inserted)
						// before copying/marking, matching native behavior where the
						// array stays untouched.
						if (!state.modified_) {
							const length = state.base_.length
							const start = normalizeSpliceStart(args[0], length)
							const deleteCount = normalizeSpliceDeleteCount(
								args.length < 2 ? undefined : args[1],
								length,
								start
							)
							if (deleteCount === 0 && args.length <= 2) {
								return []
							}
						}

						// Normalize the insertion index against the pre-splice
						// length of the current copy (which can differ from
						// base_.length after earlier mutations in the same
						// producer), so cross-reference bookkeeping targets the
						// same slots the native splice actually writes to.
						const insertionIndex = normalizeSpliceStart(
							args[0],
							latest(state).length
						)

						const res = executeArrayMethod(state, () =>
							state.copy_!.splice(...(args as [number, number, ...any[]]))
						)
						markAllIndicesReassigned(state)
						// Handle cross-references for inserted values (args from index 2+)
						if (args.length > 2) {
							handleInsertedValues(state, insertionIndex, args.slice(2))
						}
						return res
					}
				} else {
					// Handle non-mutating methods
					return handleNonMutatingOperation(state, method, args)
				}
			} finally {
				// Always exit operation mode - must be in finally to handle exceptions
				exitOperation(state)
			}
		}
	}

	/**
	 * Handles non-mutating array methods with different return semantics.
	 *
	 * **Subset operations** return draft proxies for mutation tracking:
	 * - `filter`, `slice`: Return `state.draft_[i]` for each selected element
	 * - `find`, `findLast`: Return `state.draft_[i]` for the found element
	 *
	 * This allows mutations on returned elements to propagate back to the draft:
	 * ```ts
	 * const filtered = draft.items.filter(x => x.value > 5)
	 * filtered[0].value = 999 // Mutates draft.items[originalIndex]
	 * ```
	 *
	 * **Transform operations** return base values (no draft tracking):
	 * - `concat`, `flat`: These create NEW arrays rather than selecting subsets.
	 *   Since the result structure differs from the original, tracking mutations
	 *   back to specific draft indices would be impractical/impossible.
	 *
	 * **Primitive operations** return the native result directly:
	 * - `indexOf`, `includes`, `some`, `every`, `join`, etc.
	 *
	 * @param state - The proxy array state
	 * @param method - The non-mutating method name
	 * @param args - Arguments passed to the method
	 * @returns Drafts for subset operations, base values for transforms, primitives otherwise
	 */
	function handleNonMutatingOperation(
		state: ProxyArrayState,
		method: NonMutatingArrayMethod,
		args: any[]
	) {
		const source = latest(state)

		// Methods that return arrays with selected items - need to return drafts
		if (method === "filter") {
			const predicate = args[0]
			const result: any[] = []

			// First pass: call predicate on base values to determine which items pass
			for (let i = 0; i < source.length; i++) {
				if (predicate(source[i], i, source)) {
					// Only create draft for items that passed the predicate
					result.push(state.draft_[i])
				}
			}

			return result
		}

		if (FIND_METHODS.has(method)) {
			const predicate = args[0]
			const isForward = method === "find"
			const step = isForward ? 1 : -1
			const start = isForward ? 0 : source.length - 1

			for (let i = start; i >= 0 && i < source.length; i += step) {
				if (predicate(source[i], i, source)) {
					return state.draft_[i]
				}
			}
			return undefined
		}

		if (method === "slice") {
			const rawStart = args[0] ?? 0
			const rawEnd = args[1] ?? source.length

			// Normalize negative indices
			const start = normalizeSliceIndex(rawStart, source.length)
			const end = normalizeSliceIndex(rawEnd, source.length)

			const result: any[] = []

			// Return drafts for items in the slice range
			for (let i = start; i < end; i++) {
				result.push(state.draft_[i])
			}

			return result
		}

		// For other methods, call on base array directly:
		// - indexOf, includes, join, toString: Return primitives, no draft needed
		// - concat, flat: Return NEW arrays (not subsets). Elements are base values.
		//   This is intentional - concat/flat create new data structures rather than
		//   selecting subsets of the original, making draft tracking impractical.
		return source[method as keyof typeof Array.prototype](...args)
	}

	loadPlugin(PluginArrayMethods, {
		createMethodInterceptor,
		isArrayOperationMethod,
		isMutatingArrayMethod
	})
}
