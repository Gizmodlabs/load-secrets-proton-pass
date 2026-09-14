// The envelope real `pass-cli item view --output json` emits, captured from
// pass-cli 2.1.0 against a live vault. Built-in fields sit in a tagged variant
// under item.content.content; custom fields sit in item.content.extra_fields
// (or, for a Custom item, in Custom.sections[].section_fields[]) as
// { name, content: { Text | Hidden | Totp | Timestamp: value } }.
//
// Every fixture builds on this so a pass-cli schema change breaks one place
// rather than being re-invented per test.

const LOGIN_DEFAULTS = {
  email: '',
  username: '',
  password: '',
  urls: [],
  totp_uri: '',
  passkeys: [],
}

export function customField(name, kind = 'Text') {
  return { name, content: { [kind]: kind === 'Timestamp' ? 1730000000 : `${name}-value` } }
}

/** A Login item. `builtins` overrides the scalars; `custom` names its extra fields. */
export function loginItem(title, { builtins = {}, custom = [] } = {}) {
  return envelope(title, { Login: { ...LOGIN_DEFAULTS, ...builtins } }, custom)
}

/** A Custom item, whose fields hang off sections instead of extra_fields. */
export function customItem(title, sectionFieldNames) {
  const sections = [{ section_name: 'Section 1', section_fields: sectionFieldNames.map(name => customField(name)) }]
  return envelope(title, { Custom: { sections } }, [])
}

function envelope(title, content, custom) {
  return {
    item: {
      id: 'mock-item-id',
      share_id: 'mock-share-id',
      vault_id: 'mock-vault-id',
      content: {
        title,
        note: '',
        item_uuid: 'mock-uuid',
        content,
        extra_fields: custom.map(name => customField(name)),
      },
      state: 'Active',
      flags: [],
      create_time: '2026-01-01T00:00:00',
      modify_time: '2026-01-01T00:00:00',
    },
    attachments: [],
  }
}
