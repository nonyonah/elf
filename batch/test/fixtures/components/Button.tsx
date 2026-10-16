import Icon from "./Icon";

export interface ButtonProps {
  size?: "sm" | "md";
  intent?: "primary" | "secondary";
  label?: string;
}

export default function Button({ size = "md", intent = "primary", label }: ButtonProps) {
  return (
    <button data-size={size} data-intent={intent}>
      <Icon name="arrow" />
      {label}
    </button>
  );
}
