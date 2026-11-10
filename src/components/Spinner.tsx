export default function Spinner({className = 'size-4 border-2'}: {className?: string}) {
  return (
    <span
      className={`border-primary/30 border-t-primary inline-block shrink-0 animate-spin rounded-full motion-reduce:animate-none ${className}`}
      aria-hidden="true"
    />
  );
}
