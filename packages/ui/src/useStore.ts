import React, { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { AppStore } from './store.js';

const StoreContext = createContext<AppStore | null>(null);

export const StoreProvider = StoreContext.Provider;

/** 只获取 Store；用于动作回调或由显式 Props 驱动的组件，不订阅全局变化。 */
export function useStoreApi(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreProvider 缺失');
  return store;
}

/**
 * 订阅 store 的版本号（快照为原始数字，保证引用变化可见），
 * 返回 store 实例本身；组件在每次版本变化时重渲染并直接读取最新字段。
 */
export function useStore(): AppStore {
  const store = useStoreApi();
  useSyncExternalStore(store.subscribe, store.getSnapshot, () => 0);
  return store;
}

/**
 * 按不可变引用/原始值组成的投影订阅，仍以 Store 的数值版本作为 React 快照。
 * selector 应定义在模块级；可变对象内部的显示字段必须显式投影为原始值。
 */
export function useStoreSlice(select: (store: AppStore) => readonly unknown[]): AppStore {
  const store = useStoreApi();
  const snapshot = useMemo(() => {
    let checkedVersion = -1;
    let selected: readonly unknown[] | undefined;
    let selectedVersion = 0;
    return () => {
      if (checkedVersion !== store.version) {
        const next = select(store);
        if (!selected || next.length !== selected.length || next.some((v, i) => !Object.is(v, selected![i]))) {
          selected = next;
          selectedVersion = store.version;
        }
        checkedVersion = store.version;
      }
      return selectedVersion;
    };
  }, [store, select]);
  useSyncExternalStore(store.subscribe, snapshot, () => 0);
  return store;
}
