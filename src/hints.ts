/**
 * Troubleshooting hints derived from pass-cli stderr. Mirrors the bash
 * action's print_hints: map the three common failure shapes (vault access,
 * missing item, missing field) to concrete next commands. Hints carry names
 * only — never values.
 */
export function troubleshootingHints(
  detail: string,
  vault: string,
  item: string,
  field: string,
): string[] {
  if (detail.includes('vault by name') || detail.includes('Could not find vault')) {
    return [
      `Hint: the PAT does not have access to vault '${vault}'.`,
      '  Check current scope: pass-cli pat access list-access --pat-name <YOUR-PAT-NAME>',
      `  Grant access:        pass-cli pat access grant --pat-name <YOUR-PAT-NAME> --vault-name '${vault}' --role viewer`,
    ]
  }
  if (detail.includes('item by name') || detail.includes('Could not find item')) {
    return [
      `Hint: item '${item}' was not found in vault '${vault}'. List exact names with:`,
      `  pass-cli item list '${vault}'`,
    ]
  }
  if (detail.includes('Could not find field') || detail.includes('finding field')) {
    return [
      `Hint: field '${field}' was not found on item '${item}'. See available fields with:`,
      `  pass-cli item view "pass://${vault}/${item}"`,
    ]
  }
  return []
}
