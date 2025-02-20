import { useCallback, useDebugValue, useEffect, useMemo, useRef } from 'react'
import {
  affectedToPathList,
  createProxy as createProxyToCompare,
  isChanged,
} from 'proxy-compare'
import { useSyncExternalStore } from 'use-sync-external-store/shim'
import { getVersion, snapshot, subscribe } from './vanilla'

// Unfortunately, this doesn't work with tsc.
// Hope to find a solution to make this work.
//
//   class SnapshotWrapper<T extends object> {
//     fn(p: T) {
//       return snapshot(p)
//     }
//   }
//   type Snapshot<T extends object> = ReturnType<SnapshotWrapper<T>['fn']>
//
// Using copy-paste types for now:
type AsRef = { $$valtioRef: true }
type AnyFunction = (...args: any[]) => any
type Snapshot<T> = T extends AnyFunction
  ? T
  : T extends AsRef
  ? T
  : T extends Promise<infer V>
  ? Snapshot<V>
  : {
      readonly [K in keyof T]: Snapshot<T[K]>
    }

const useAffectedDebugValue = <State extends object>(
  state: State,
  affected: WeakMap<object, unknown>
) => {
  const pathList = useRef<(string | number | symbol)[][]>()
  useEffect(() => {
    pathList.current = affectedToPathList(state, affected)
  })
  useDebugValue(pathList.current)
}

type Options = {
  sync?: boolean
}

/**
 * useSnapshot
 *
 * Create a local snapshot that catches changes. This hook actually returns a wrapped snapshot in a proxy for
 * render optimization instead of a plain object compared to `snapshot()` method.
 * Rule of thumb: read from snapshots, mutate the source.
 * The component will only re-render when the parts of the state you access have changed, it is render-optimized.
 *
 * @example A
 * function Counter() {
 *   const snap = useSnapshot(state)
 *   return (
 *     <div>
 *       {snap.count}
 *       <button onClick={() => ++state.count}>+1</button>
 *     </div>
 *   )
 * }
 *
 * [Notes]
 * Every object inside your proxy also becomes a proxy (if you don't use "ref"), so you can also use them to create
 * the local snapshot as seen on example B.
 *
 * @example B
 * function ProfileName() {
 *   const snap = useSnapshot(state.profile)
 *   return (
 *     <div>
 *       {snap.name}
 *     </div>
 *   )
 * }
 *
 * Beware that you still can replace the child proxy with something else so it will break your snapshot. You can see
 * above what happens with the original proxy when you replace the child proxy.
 *
 * > console.log(state)
 * { profile: { name: "valtio" } }
 * > childState = state.profile
 * > console.log(childState)
 * { name: "valtio" }
 * > state.profile.name = "react"
 * > console.log(childState)
 * { name: "react" }
 * > state.profile = { name: "new name" }
 * > console.log(childState)
 * { name: "react" }
 * > console.log(state)
 * { profile: { name: "new name" } }
 *
 * `useSnapshot()` depends on the original reference of the child proxy so if you replace it with a new one, the component
 * that is subscribed to the old proxy won't receive new updates because it is still subscribed to the old one.
 *
 * In this case we recommend the example C or D. On both examples you don't need to worry with re-render,
 * because it is render-optimized.
 *
 * @example C
 * const snap = useSnapshot(state)
 * return (
 *   <div>
 *     {snap.profile.name}
 *   </div>
 * )
 *
 * @example D
 * const { profile } = useSnapshot(state)
 * return (
 *   <div>
 *     {profile.name}
 *   </div>
 * )
 */
export function useSnapshot<T extends object>(
  proxyObject: T,
  options?: Options
): Snapshot<T> {
  const affected = new WeakMap()
  const lastAffected = useRef<typeof affected>()
  const lastCallback = useRef<() => void>()
  const notifyInSync = options?.sync
  const currSnapshot = useSyncExternalStore(
    useCallback(
      (callback) => {
        lastCallback.current = callback
        const unsub = subscribe(proxyObject, callback, notifyInSync)
        return () => {
          unsub()
          lastCallback.current = undefined
        }
      },
      [proxyObject, notifyInSync]
    ),
    useMemo(() => {
      let prevSnapshot: Snapshot<T> | undefined
      return () => {
        const nextSnapshot = snapshot(proxyObject)
        try {
          if (
            prevSnapshot &&
            lastAffected.current &&
            !isChanged(
              prevSnapshot,
              nextSnapshot,
              lastAffected.current,
              new WeakMap()
            )
          ) {
            // not changed
            return prevSnapshot
          }
        } catch (e) {
          // ignore if a promise or something is thrown
        }
        return (prevSnapshot = nextSnapshot)
      }
    }, [proxyObject]),
    useCallback(() => snapshot(proxyObject), [proxyObject])
  )
  const currVersion = getVersion(proxyObject)
  useEffect(() => {
    lastAffected.current = affected
    // check if state has changed between render and commit
    if (currVersion !== getVersion(proxyObject)) {
      if (lastCallback.current) {
        lastCallback.current()
      } else if (
        typeof process === 'object' &&
        process.env.NODE_ENV !== 'production'
      ) {
        console.warn('[Bug] last callback is undefined')
      }
    }
  })
  if (__DEV__) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useAffectedDebugValue(currSnapshot, affected)
  }
  const proxyCache = useMemo(() => new WeakMap(), []) // per-hook proxyCache
  return createProxyToCompare(currSnapshot, affected, proxyCache)
}
