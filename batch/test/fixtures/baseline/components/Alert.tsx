import Icon from "./Icon";

export interface AlertProps {
  tone?: "info" | "danger";
  title: string;
}

export default function Alert({ tone = "info", title }: AlertProps) {
  return (
    <div data-tone={tone}>
      <Icon name="warning" />
      {title}
    </div>
  );
}
