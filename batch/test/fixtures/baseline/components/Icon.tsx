export interface IconProps {
  name?: string;
}

export default function Icon({ name = "star" }: IconProps) {
  return <svg role="img" aria-label={name} />;
}
