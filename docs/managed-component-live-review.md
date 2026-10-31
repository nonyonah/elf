# Managed component acceptance review

Target: Untitled (`eu8zGUOsrdyXXQqvJeyl1E`). Isolated temporary project only.

The full read-only plan lists two component creates. The individual selection
lists exactly one create with no issues:
`AcceptanceManagedButton.tsx#AcceptanceManagedButton`.
`AcceptanceUnselectedCard` is excluded and must never be created in Figma.
No token, style or collection writes are listed.

## Approved scope requested

1. Create AcceptanceManagedButton: 120 × 40, horizontal auto layout, padding
   8px vertical / 16px horizontal, 8px corners, literal #6f3cfa fill. Label:
   “Continue”, Inter Regular 14, literal #ffffff. Documentation:
   “Runs one immediate acceptance-test action.”
2. Verify component drift from a temporary source/description edit. Apply a
   reviewed individual width update from 120 to 128 and verify the master ID.
3. Remove only the unused temporary card fixture, review the full temporary
   project, then enable automatic sync for this one test component. Save its
   supported description with width 144; let the real installed watcher apply
   the change. Save width 120 to restore it, verify the same master ID, then
   pause automatic sync and stop the test watcher.
4. Attempt a stale reviewed plan after editing the temporary description;
   confirm rejection before any write. Restore the fixture and prepare a fresh
   plan when needed.

Do not overwrite existing resources, delete the sample, alter real project
configuration or send additional Slack messages. Existing Elf-tagged Figma
components from other work are outside this fixture; record baseline differences
rather than claiming the entire file is clean.
