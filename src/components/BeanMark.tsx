interface BeanMarkProps {
  size?: number;
}

/** A compact, original mark used in Bean's overlay and controls. */
export default function BeanMark({ size = 24 }: BeanMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className="bean-mark"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2" y="2" width="28" height="28" rx="9" fill="#FFF7E9" stroke="#243B68" strokeWidth="2" />
      <path d="M9 13.4C7.5 10.4 8.6 7.9 11.2 8.2C13 8.4 14.1 10.5 14.4 12.1" fill="#DEA06A" stroke="#243B68" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M23 13.4C24.5 10.4 23.4 7.9 20.8 8.2C19 8.4 17.9 10.5 17.6 12.1" fill="#DEA06A" stroke="#243B68" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9.2 17.4C9.2 12.9 12.1 10.7 16 10.7C19.9 10.7 22.8 12.9 22.8 17.4C22.8 21.9 20.3 24.7 16 24.7C11.7 24.7 9.2 21.9 9.2 17.4Z" fill="#F2B979" stroke="#243B68" strokeWidth="1.6" />
      <circle cx="13.2" cy="16.2" r="1.1" fill="#243B68" />
      <circle cx="18.8" cy="16.2" r="1.1" fill="#243B68" />
      <path d="M14.2 19.2C15.2 20.3 16.8 20.3 17.8 19.2" stroke="#243B68" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M14.9 18.1L16 17.2L17.1 18.1L16 19Z" fill="#B9665C" stroke="#243B68" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}
