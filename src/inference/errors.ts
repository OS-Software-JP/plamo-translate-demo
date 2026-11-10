// 利用者に見せるエラー。技術的な詳細ではなく、取れる行動を示す。
import type {UnsupportedReason, WorkerFailure} from './protocol';

export type UserErrorCode =
  | UnsupportedReason
  | 'buffer-limit'
  | 'insufficient-storage'
  | 'download-failed'
  | 'gpu-out-of-memory'
  | 'gpu-error'
  | 'gpu-lost'
  | 'worker-crashed'
  | 'input-too-long'
  | 'reserved-token'
  | 'tone-unavailable'
  | 'unknown';

export interface UserFacingError {
  code: UserErrorCode;
  message: string;
  action: string;
}

export const UNSUPPORTED_ERRORS: Record<UnsupportedReason, UserFacingError> = {
  'insecure-context': {
    code: 'insecure-context',
    message: 'このページは HTTPS か localhost でしか動きません。',
    action: 'HTTPS の URL で開き直してください。',
  },
  'webgpu-unavailable': {
    code: 'webgpu-unavailable',
    message: 'このブラウザは WebGPU に対応していません。',
    action: '最新の Chrome か Edge をお使いください。',
  },
  'no-adapter': {
    code: 'no-adapter',
    message: 'WebGPU を使える GPU が見つかりません。',
    action: 'GPU ドライバとブラウザの設定を確認してください。',
  },
  'software-adapter': {
    code: 'software-adapter',
    message: 'ハードウェアの GPU を使えません。',
    action: 'ブラウザの設定でハードウェアアクセラレーションを有効にしてください。',
  },
};

export const GPU_ERRORS = {
  outOfMemory: {
    code: 'gpu-out-of-memory',
    message: 'GPU のメモリが足りません。',
    action: '他のアプリを閉じるか、小さいモデルやコンテキスト長を選んでください。',
  },
  error: {
    code: 'gpu-error',
    message: 'GPU でエラーが起きました。訳文が壊れている可能性があります。',
    action: 'モデルを読み込み直してください。',
  },
  lost: {
    code: 'gpu-lost',
    message: 'GPU が使えなくなりました。',
    action: 'モデルを読み込み直してください。解消しない場合はページを再読み込みしてください。',
  },
  crashed: {
    code: 'worker-crashed',
    message: '処理を続けられなくなりました。',
    action: 'モデルを読み込み直してください。',
  },
} as const satisfies Record<string, UserFacingError>;

export const BUFFER_LIMIT_ERROR: UserFacingError = {
  code: 'buffer-limit',
  message: 'この GPU ではこのモデルを動かせません。',
  action: '小さいモデルを選ぶか、別の端末をお使いください。',
};

export const RESERVED_TOKEN_ERROR: UserFacingError = {
  code: 'reserved-token',
  message: '使用できない文字列 <|plamo: が含まれています。',
  action: '該当の文字列を取り除いてください。',
};

const formatTokens = (tokens: number): string => tokens.toLocaleString('ja-JP');

/**
 * 翻訳の依頼に含めた詳細オプション。どちらもコンテキスト長を使うので、入力超過と上限到達の文面で
 * 短くできるものとして名指しする (使っていないものは挙げない)。
 */
export interface UsedOptions {
  context: boolean;
  glossary: boolean;
}

const NO_OPTIONS: UsedOptions = {context: false, glossary: false};

/** コンテキスト長を使った入力の呼び方。例: 「原文と参考文脈の合計」。 */
function inputSubject({context, glossary}: UsedOptions): string {
  if (context && glossary) return '原文、参考文脈、用語集の合計';
  if (context) return '原文と参考文脈の合計';
  if (glossary) return '原文と用語集の合計';
  return '原文';
}

/** 入力超過と上限到達のときに取れる行動。 */
export function shortenAction({context, glossary}: UsedOptions = NO_OPTIONS): string {
  const shorten =
    context && glossary
      ? '参考文脈や用語集を減らすか、'
      : context
        ? '参考文脈を短くするか、'
        : glossary
          ? '用語集を減らすか、'
          : '';
  return `原文を分割するか、${shorten}より大きいコンテキスト長で読み込み直してください。`;
}

/** Worker の失敗を、利用者に見せるエラーに変換する。used は翻訳の依頼に含めた詳細オプション。 */
export function describeFailure(failure: WorkerFailure, used: UsedOptions = NO_OPTIONS): UserFacingError {
  switch (failure.code) {
    case 'input-too-long': {
      const {inputTokens, tokenLimit} = failure;
      const detail =
        inputTokens !== undefined && tokenLimit !== undefined
          ? ` (${formatTokens(inputTokens)} トークン、上限 ${formatTokens(tokenLimit)})`
          : '';
      return {
        code: 'input-too-long',
        message: `${inputSubject(used)}が長すぎます${detail}。`,
        action: shortenAction(used),
      };
    }
    case 'insufficient-storage':
      return {
        code: 'insufficient-storage',
        message: 'モデルの保存に必要な空き容量がありません。',
        action: 'ディスクの空きを増やすか、小さいモデルを選んでください。',
      };
    case 'download-failed':
      return {
        code: 'download-failed',
        message: 'モデルを取得できませんでした。',
        action: '通信環境を確認して、もう一度お試しください。',
      };
    case 'tone-unavailable':
      return {
        code: 'tone-unavailable',
        message: '読み込んだモデルでは口調を使えません。',
        action: '文体を変えて翻訳してください。',
      };
    default:
      return {
        code: 'unknown',
        message: '予期しないエラーが起きました。',
        action: 'もう一度お試しください。解消しない場合はページを再読み込みしてください。',
      };
  }
}
