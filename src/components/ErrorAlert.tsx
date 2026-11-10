import type {UserFacingError} from '../inference/errors';

export default function ErrorAlert({error}: {error: UserFacingError}) {
  return (
    <div role="alert" className="alert alert-error alert-soft text-sm md:text-base">
      <p>
        {error.message}
        <span className="ml-1">{error.action}</span>
      </p>
    </div>
  );
}
