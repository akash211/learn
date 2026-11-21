# Parametrization and Test IDs

Parametrization turns a collection of examples into separately reported test cases. It is useful when one behavior has several meaningful inputs, boundaries, or outcomes. The goal is not to reduce line count; it is to ensure that cases remain named, independent, and understandable when one fails.

## Parameterize behavior, not arbitrary combinations

`@pytest.mark.parametrize` supplies argument values to a test function. Pytest collects one test item per parameter set and reports each outcome independently.

```python
import pytest

@pytest.mark.parametrize(
    "raw, expected",
    [
        (" Alice ", "Alice"),
        ("", ""),
        ("\tSam\n", "Sam"),
    ],
)
def test_normalize_name(raw, expected):
    assert normalize_name(raw) == expected
```

The parameter-name string is a comma-separated list of Python argument names; whitespace is fine but consistent formatting helps. Each tuple supplies one row. For a single argument, use one-element tuples such as `("input",)`, or pass values directly in a list of scalar values. Parameterization is particularly useful for equivalence classes: valid and invalid encodings, inclusive boundaries, empty versus populated input, and known regression examples.

Do not turn a test into a Cartesian product simply because the decorator allows it. Ten values for each of five arguments make 100,000 cases; the suite may become slow and a failure report may not explain the policy being tested. Split dimensions when they represent different behaviors, and use a smaller representative set when interactions are not the subject of the test. If the combinations are genuinely combinatorial, consider pairwise generation with a deliberate tool and document the coverage intent.

## Test IDs are part of the interface

The default IDs often come from parameter values. They are useful for simple values, but can be unstable, verbose, or unhelpful for complex objects. Supply readable IDs with `pytest.param` or `ids=`:

```python
@pytest.mark.parametrize(
    "payload, status",
    [
        pytest.param({"name": "Ada"}, 201, id="valid-user"),
        pytest.param({}, 422, id="missing-name"),
        pytest.param(None, 400, id="null-body"),
    ],
)
def test_create_user(payload, status, client):
    response = client.post("/users", json=payload)
    assert response.status_code == status
```

IDs appear in test node IDs and can be selected with `-k`. They also show up in CI logs, so choose stable descriptive names. Avoid including secrets, personal data, huge representations, or values that change with time. The `ids` argument can be a list of IDs or a callable that derives one for each parameter value; explicit `pytest.param(..., id=...)` is usually easiest when each case has a semantic name.

A useful ID says why the case matters, not merely what type it holds. `empty-input`, `limit-inclusive`, and `expired-token` are better than `case-2`. If a behavior has a concise policy name, use that as the ID and include the actual boundary in a test comment or parameter object where needed.

## Stacking parametrization

Multiple parametrization decorators expand into combinations. For example, decorating with `locale` and `currency` produces every locale-currency pair. This is concise when every combination is intentional, but can multiply test counts unexpectedly and create semantically invalid combinations.

```python
@pytest.mark.parametrize("currency", ["USD", "EUR"])
@pytest.mark.parametrize("locale", ["en", "fr"])
def test_format_price(locale, currency):
    ...
```

Use one decorator with explicit rows when only some combinations are valid or when the relationship between fields is important. Explicit rows are more verbose but document the domain model. For long rows, a small immutable dataclass or named tuple can improve readability, as long as values still map clearly to the test parameters.

## Combining fixtures and parameters

A parameterized test can request fixtures normally; each parameter case receives fixture setup according to its scope. `@pytest.mark.parametrize` values are not fixtures, and fixture values are not automatically duplicated across parameter values. If a resource itself must vary, use indirect parametrization to pass a configuration value into a fixture:

```python
@pytest.fixture
def backend(request):
    return make_backend(request.param)

@pytest.mark.parametrize("backend", ["memory", "sqlite"], indirect=True)
def test_backend_contract(backend):
    assert backend.fetch("missing") is None
```

Use indirect mode when fixture setup is the point of variation, not to hide ordinary data. A reader should be able to tell which values are input examples and which require lifecycle management. Parametrized fixtures also exist: their scope and IDs apply to each configured fixture value, and they can multiply dependent test cases just like decorators.

## Expected exceptions as cases

Expected exceptions can be tested inside each example, but make the assertion precise enough to catch the intended failure. A loop inside one test loses per-case reporting and can stop at the first failure. Prefer separate parameterized items:

```python
@pytest.mark.parametrize(
    "text",
    [pytest.param("", id="empty"), pytest.param("not-a-number", id="nonnumeric")],
)
def test_parse_rejects_invalid(text):
    with pytest.raises(ValueError, match="integer"):
        parse_count(text)
```

If different invalid inputs should raise different exception types, use separate tests or include expected type as a parameter and pass it to `pytest.raises`. Do not catch broad `Exception` just to make heterogeneous examples fit one body.

## Common mistakes

- Reusing mutable parameter values. Pytest passes parameter objects as-is; it does not copy a list or dict between cases. Mutations can contaminate later cases.
- Creating IDs from random or environment-dependent values, making `--last-failed` and `-k` selection unstable.
- Parameterizing a behavior's entire input space instead of its meaningful partitions.
- Using `pytest.param(..., marks=pytest.mark.xfail)` to conceal a real defect indefinitely. Put the reason and a removal condition nearby.
- Assuming an indirect fixture parameter is deep-copied or converted automatically.

## Production notes

Use `pytest --collect-only -q` to inspect item count and node IDs before a large parameterization lands. Stable node IDs also make targeted execution practical: `pytest tests/test_api.py -k 'valid-user or null-body'`. When an item is difficult to name, that is often a sign the test combines several policies or uses overly complex inputs. Clear parametrization gives each regression a durable address in reports and review discussions.

## Build a case matrix before writing decorators

For boundary-heavy code, list the behavior partitions first. A numeric validator might distinguish below minimum, exactly minimum, ordinary valid value, exactly maximum, and above maximum. A URL parser might split scheme, host, path, missing component, and malformed encoding. This table is a compact specification; the parametrized rows should map directly to it. It also exposes when two rows are duplicates and when an important boundary is missing.

Do not parameterize invalid cases together if they are expected to fail for unrelated reasons. For example, a missing field and an invalid field type may produce different API error structures. Use separate tests or include the expected error code as data and assert it explicitly. Parameterization should improve failure localization, not hide which contract differs.

For difficult inputs, define a small test-case dataclass with named fields such as `name`, `payload`, and `expected_status`. Keep the case table near the test, and still provide explicit pytest IDs. A custom object representation is not a substitute for IDs because it may change with implementation details. Avoid loading parameter values from mutable global lists that tests alter; pytest does not clone parameter objects between invocations.

When collecting large suites, verify not only total count but also item identity. `--collect-only -q` reveals accidental duplicate collection and confirms that markers and IDs appear as intended. Keep parameter sets reasonably small enough that a single failure can be read in CI without scrolling through hundreds of nearly identical cases.
