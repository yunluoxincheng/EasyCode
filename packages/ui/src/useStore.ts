import React, { createContext, useContext, useSyncExternalStore } from 'react';
import type { AppStore } from './store.js';

const StoreContext = createContext<AppStore | null>(null);

export const StoreProvider = StoreContext.Provider;

/**
 * 订阅 store 的版本号（快照为原始数字，保证引用变化可见），
 * 返回 store 实例本身；组件在每次版本变化时重渲染并直接读取最新字段。
 */
export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('StoreProvider 缺失');
  useSyncExternalStore(store.subscribe, store.getSnapshot, () => 0);
  return store;
}
