type BriefSession = { id: string; revision: number; requirements: Record<string,string> };

export async function saveBrief<T extends BriefSession>(initial: T, entries: [string,string][], save: (id: string, revision: number, field: string, value: string) => Promise<T>): Promise<T> {
  // Capture the original form before any await; navigation cannot redirect later writes.
  const id = initial.id;
  const changes = entries.filter(([field,value]) => value !== initial.requirements[field]).map(([field,value]) => [field,value] as const);
  let session = initial;
  for (const [field,value] of changes) session = await save(id, session.revision, field, value);
  return session;
}
