import * as React from "react";
import { CreateProjectDialog } from "@/components/create-project-dialog";

type CreateProjectContextValue = {
  openCreateProject: () => void;
};

const CreateProjectContext = React.createContext<CreateProjectContextValue | null>(
  null,
);

export function useCreateProject(): CreateProjectContextValue {
  const value = React.useContext(CreateProjectContext);
  if (!value) {
    throw new Error("useCreateProject must be used inside CreateProjectProvider");
  }
  return value;
}

export function CreateProjectProvider({
  children,
  onCreated,
}: {
  children: React.ReactNode;
  onCreated: (project: { id: string; name: string }) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const value = React.useMemo(
    () => ({ openCreateProject: () => setOpen(true) }),
    [],
  );

  return (
    <CreateProjectContext.Provider value={value}>
      {children}
      <CreateProjectDialog
        onCreated={onCreated}
        onOpenChange={setOpen}
        open={open}
      />
    </CreateProjectContext.Provider>
  );
}
