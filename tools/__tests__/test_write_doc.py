"""The twelfth recurrence: the documentation was the hazard, and the carrier was the fix.

## What this file records

Sections 1 through 4j, plus the tenth-fix and eleventh-fix work, all treat the hazard as
a thing to DETECT and the author as a thing to WARN. The twelfth recurrence shows why
that framing cannot terminate: the recurrence was caused by the *documentation section
about the previous recurrence*, whose example table spells the sequences being explained.

    the defect  ->  is documented  ->  the doc contains it  ->  the doc kills its carrier
                                                              ->  a new defect

Eleven rounds of detection could not stop that loop, because detection happens in the
guard, and the guard runs on committed files -- never on the command that writes them.

## The fix is the carrier, not another rule

`tools/write-doc.py` removes the shell from the path entirely:

    section text --(stdin or --section-file)--> write-doc.py --> Markdown

Nothing on that path tokenises the text, so the text may spell anything. The tests below
are unusual for this repository in that they assert about the CARRIER: the claim is that
a spelled hazard survives, which is the exact opposite of every other test file here.

## Why asserting survival is the right test

A test that only checked "the tool appends text" would pass on a carrier that still
mangled it. The property that matters is the one the previous eleven fixes lacked --
byte-for-byte survival of text that would have killed a command-line carrier -- so that
is what is asserted, and the hazard is built from `chr()` so this test file is itself
safe to edit through any channel.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / 'write-doc.py'

DOLLAR = chr(36)
BRACE = chr(123)
CLOSE = chr(125)
QUOTE = chr(34)


def _load():
    spec = importlib.util.spec_from_file_location('write_doc_under_test', MODULE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTheCarrierIsTheFix:
    def test_a_spelled_unterminated_opener_survives_byte_for_byte(self, tmp_path: Path) -> None:
        """The twelfth recurrence, replayed against the tool that replaced its carrier.

        This is the assertion no previous fix could make: the sequence is SPELLED, not
        assembled, and it still lands intact. Under a command-line carrier this exact
        text is what killed the call.
        """
        module = _load()
        document = tmp_path / 'doc.md'
        section = 'Text with a spelled opener: ' + DOLLAR + BRACE + 'q\n'
        module.append_section(document, section, dry_run=False)
        assert DOLLAR + BRACE in document.read_text(encoding='utf-8')

    def test_the_extreme_case_the_quoted_json_tail_survives(self, tmp_path: Path) -> None:
        """The tail that produced the most confusing reports: a quoted JSON fragment.

        Built from bytes so the TEST FILE is safe; spelled in the DOCUMENT so the claim
        is about the document's carrier, which is the whole point.
        """
        module = _load()
        document = tmp_path / 'doc.md'
        section = 'echo ' + DOLLAR + BRACE + 'q' + QUOTE + '],\nmore text\n'
        module.append_section(document, section, dry_run=False)
        written = document.read_text(encoding='utf-8')
        assert DOLLAR + BRACE + 'q' + QUOTE + '],' in written

    def test_a_closed_expansion_also_survives(self, tmp_path: Path) -> None:
        """The ordinary case, so the tool is not only exercised on the exotic one."""
        module = _load()
        document = tmp_path / 'doc.md'
        section = 'Value: ' + DOLLAR + BRACE + 'HOME' + CLOSE + '\n'
        module.append_section(document, section, dry_run=False)
        assert DOLLAR + BRACE + 'HOME' + CLOSE in document.read_text(encoding='utf-8')

    def test_the_tool_transforms_nothing(self, tmp_path: Path) -> None:
        """No escaping, no sanitising: the content is the author's, byte for byte.

        A tool that rewrote the text would be a second rule about content, and the
        content is what must survive. Safety comes from the carrier, not the content.
        """
        module = _load()
        document = tmp_path / 'doc.md'
        section = 'tabs\there  trailing   \n'
        module.append_section(document, section, dry_run=False)
        assert document.read_text(encoding='utf-8').endswith(section)


class TestTheToolIsSafeToRetry:
    def test_appending_twice_does_not_duplicate(self, tmp_path: Path) -> None:
        """A failed run must be retryable, which is what makes the carrier usable.

        The section is identified by its first non-empty line. That is this repository's
        heading convention rather than a guess: every section in these documents opens
        with one, and a general "same section" notion is not something the tool can
        invent without becoming a second rule about content.
        """
        module = _load()
        document = tmp_path / 'doc.md'
        section = '#### 4.1.14 heading\nbody\n'
        module.append_section(document, section, dry_run=False)
        module.append_section(document, section, dry_run=False)
        assert document.read_text(encoding='utf-8').count('#### 4.1.14 heading') == 1

    def test_dry_run_writes_nothing(self, tmp_path: Path) -> None:
        module = _load()
        document = tmp_path / 'doc.md'
        module.append_section(document, 'section\n', dry_run=True)
        assert not document.exists()

    def test_append_preserves_the_existing_document(self, tmp_path: Path) -> None:
        """Appending only ever adds, so a partial failure cannot shorten a document."""
        module = _load()
        document = tmp_path / 'doc.md'
        document.write_text('original\n', encoding='utf-8')
        module.append_section(document, 'added\n', dry_run=False)
        text = document.read_text(encoding='utf-8')
        assert text.startswith('original')
        assert text.endswith('added\n')


class TestTheCommandLineEntryPoint:
    def test_section_can_be_supplied_by_file_without_naming_it_on_a_command_line(
        self, tmp_path: Path
    ) -> None:
        """The CLI path, exercised the way a caller uses it.

        The section travels in a FILE and the command line names only paths, so the text
        never appears in a command. That is the property under test, and it is why the
        assertion is about content arriving rather than about an argument being parsed.
        """
        document = tmp_path / 'doc.md'
        section_file = tmp_path / 'section.md'
        section_file.write_text('#### heading\ntext ' + DOLLAR + BRACE + 'q\n', encoding='utf-8')
        done = subprocess.run(
            [
                sys.executable,
                str(MODULE_PATH),
                '--append',
                str(document),
                '--section-file',
                str(section_file),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert done.returncode == 0, done.stderr
        assert DOLLAR + BRACE + 'q' in document.read_text(encoding='utf-8')

class TestTheIdentityLineIsAHeading:
    """The first real use of this tool refused a section that was not present.

    The section opened with a `---` thematic break, as every section in these documents
    does. The "already present" check looked for the first non-empty line, found `---`,
    matched it against the document, and skipped the write -- reporting success while
    changing nothing.

    These tests pin the two halves: a separator does not identify a section, and a
    heading does.
    """

    def test_a_thematic_break_is_not_an_identity(self, tmp_path: Path) -> None:
        """The regression, exactly as it happened."""
        module = _load()
        document = tmp_path / 'doc.md'
        document.write_text('---\n\n### 1. an existing section\n', encoding='utf-8')
        section = '---\n\n### 54. a new section\nbody\n'
        module.append_section(document, section, dry_run=False)
        assert '### 54. a new section' in document.read_text(encoding='utf-8')

    def test_a_heading_is_the_identity(self, tmp_path: Path) -> None:
        module = _load()
        assert module._identity_line('---\n\n### 54. title\nbody\n') == '### 54. title'

    def test_a_section_with_only_separators_is_appended(self, tmp_path: Path) -> None:
        """An empty marker appends rather than risks dropping the section.

        Appending twice is recoverable; silently dropping a section is not, so the
        unknown case resolves in the recoverable direction.
        """
        module = _load()
        assert module._identity_line('---\n===\n***\n') == ''
        document = tmp_path / 'doc.md'
        module.append_section(document, '---\n===\n***\n', dry_run=False)
        assert document.exists()
