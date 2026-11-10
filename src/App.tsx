import GitHubLink from './components/GitHubLink';
import LicenseFooter from './components/LicenseFooter';
import ModelPanel from './components/ModelPanel';
import ThemeToggle from './components/ThemeToggle';
import TranslatePanel from './components/TranslatePanel';
import {useTranslator} from './hooks/useTranslator';

export default function App() {
  const {state, actions} = useTranslator();
  const {translation} = state;
  const translating = translation.kind === 'generating' || translation.kind === 'stopping';

  return (
    <div className="mx-auto flex min-h-dvh max-w-[1536px] flex-col gap-3 px-4 py-4 md:gap-4 md:px-12 md:py-5">
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-4 md:items-start">
          {/* スマートフォン幅 (375 px) では、右のボタン 2 つと並べても 1 行に収まる大きさにする。 */}
          <h1 className="font-serif text-[1.375rem] leading-tight font-bold md:text-4xl">PLaMo Translate Demo</h1>
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <GitHubLink />
          </div>
        </div>
        {/*
          スマートフォン幅では 1 行に収める。画面の幅いっぱいに置き、約物を詰め (palt)、幅に合わせて文字を小さくする。
          28 は約物を詰めたこの文の幅 (27.6 文字分) に、代わりのフォントで表示されたときの余裕を足した値。
        */}
        <p className="text-[length:min(0.875rem,calc((100vw-2rem)/28))] whitespace-nowrap [font-feature-settings:'palt'] md:text-base md:[font-feature-settings:normal]">
          ブラウザ内で翻訳します。入力した文章は外部に送信されません。
        </p>
      </header>

      <ModelPanel
        model={state.model}
        selectedModelId={state.selectedModelId}
        selectedContextLength={state.selectedContextLength}
        cachedModelIds={state.cachedModelIds}
        unavailableModelIds={state.unavailableModelIds}
        gpuDescription={state.gpuDescription}
        translating={translating}
        actions={actions}
      />

      <TranslatePanel state={state} actions={actions} />

      <LicenseFooter gpuName={state.gpuDescription} />
    </div>
  );
}
