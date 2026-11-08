export type LatestCopyPhase = "preparing" | "checking" | "writing";

export interface LatestCopyRevisionResponse<TData> {
  success: boolean;
  conversationId?: string;
  revision?: string;
  changed?: boolean;
  data?: TData;
  error?: string;
}

export async function runLatestCopyTransaction<TData, TPrepared>(options: {
  initialData: TData;
  getRevision(data: TData): string | undefined;
  prepare(data: TData): Promise<TPrepared>;
  check(revision: string): Promise<LatestCopyRevisionResponse<TData>>;
  ensureCurrent(prepared: TPrepared): Promise<void>;
  write(prepared: TPrepared): Promise<void>;
  onPhase(phase: LatestCopyPhase): void;
}): Promise<void> {
  let data = options.initialData;
  options.onPhase("preparing");
  let prepared = await options.prepare(data);

  const getRequiredRevision = (value: TData): string => {
    const revision = options.getRevision(value);
    if (!revision) throw new Error("Could not verify the active conversation branch before copying.");
    return revision;
  };

  const check = async (revision: string): Promise<LatestCopyRevisionResponse<TData>> => {
    const response = await options.check(revision);
    if (!response.success || !response.revision) {
      throw new Error(response.error ?? "Could not verify the active conversation branch before copying.");
    }
    return response;
  };

  let revision = getRequiredRevision(data);
  await options.ensureCurrent(prepared);
  options.onPhase("checking");
  let current = await check(revision);

  if (current.revision !== revision || current.changed === true) {
    if (!current.data || getRequiredRevision(current.data) !== current.revision) {
      throw new Error("The conversation changed while the latest answer was being prepared. Please try again.");
    }

    data = current.data;
    options.onPhase("preparing");
    prepared = await options.prepare(data);
    revision = getRequiredRevision(data);
    await options.ensureCurrent(prepared);
    options.onPhase("checking");
    current = await check(revision);
    if (current.revision !== revision || current.changed === true) {
      throw new Error("The conversation changed again during copying. Please try again.");
    }
  }

  await options.ensureCurrent(prepared);
  options.onPhase("writing");
  await options.write(prepared);
}
