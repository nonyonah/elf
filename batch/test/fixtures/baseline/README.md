These are stable automated-test inputs. The adjacent ../components directory
and ../tokens.json are also used for live Elf examples and can be edited during
manual acceptance. Tests import this baseline through batch/test/helpers.ts so
local component/token edits cannot silently invalidate the initial sync state.
Update baseline inputs only when deliberately changing the tested behavior;
keep live examples independent.
