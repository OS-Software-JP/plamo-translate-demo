import {useEffect, useSyncExternalStore} from 'react';
import {translatorStore} from '../inference/translatorStore';

export const translatorActions = {
  selectModel: translatorStore.selectModel,
  selectContextLength: translatorStore.selectContextLength,
  setOptions: translatorStore.setOptions,
  setAdvanced: translatorStore.setAdvanced,
  load: translatorStore.load,
  cancelDownload: translatorStore.cancelDownload,
  dismissFailure: translatorStore.dismissFailure,
  deleteModel: translatorStore.deleteModel,
  translate: translatorStore.translate,
  stop: translatorStore.stop,
};

export type TranslatorActions = typeof translatorActions;

/** 推論の状態と操作を UI に渡す。 */
export function useTranslator() {
  const state = useSyncExternalStore(translatorStore.subscribe, translatorStore.getSnapshot);
  useEffect(() => {
    void translatorStore.initialize();
  }, []);
  return {state, actions: translatorActions};
}
