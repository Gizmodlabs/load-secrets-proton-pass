// Types for item-json.mjs, which stays plain JS so the mock pass-cli shim can
// import it directly when spawned as a bare node script.

export interface CustomFieldEntry {
  name: string
  content: Record<string, string | number>
}

export declare function customField(name: string, kind?: string): CustomFieldEntry

export declare function loginItem(
  title: string,
  options?: { builtins?: Record<string, unknown>; custom?: string[] },
): unknown

export declare function customItem(title: string, sectionFieldNames: string[]): unknown
