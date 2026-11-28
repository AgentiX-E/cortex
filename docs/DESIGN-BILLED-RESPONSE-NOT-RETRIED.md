# A billed response is reported, never retried

**The defect this records.** The MemCog driver treated a JSON decode failure on an HTTP 200 response exactly like a
transport failure: it retried up to three times. But the metering proxy records a call on *any* status below 400,
*before* the driver decodes the body — a non-JSON 200 (a gateway error page, a truncated body) is billed once and
usage comes back as zero. Retrying it charged the same logical call two more times and inflated the `calls` column
in the comparison, while the error the caller finally saw said only "three attempts" with no hint that a malformed
body had come back at all.

## 1. Why this is the same failure the last four iterations closed

The preceding iterations found the same shape elsewhere: a zero-usage frame erasing a bill, a variable-dimension
cache key ignoring width, a value declared in the manifest but not injected into the client, an environment name
the workflow never set. In each case one instrument recorded a fact and another reported a different one, silently.

Here the split is inside a single function, between two moments that look like one `try` block but are not:

- **Transport** (`urlopen`): before a response is read, the proxy books a failure and no call. A second attempt
  costs nothing extra and can still succeed. Retry is correct.
- **Decode** (`json.loads`): the body is in hand, so the call is already billed. A second attempt charges the same
  logical call again and cannot be justified by "it might not have counted."

`json.JSONDecodeError` was in the same `except` tuple as `HTTPError`/`URLError`/`OSError`, collapsing the two moments
into one retry policy.

## 2. The concrete failure, reproduced

A stand-in upstream returned HTTP 200 with `Content-Type: text/html` and a non-JSON body. Through the real metering
proxy:

1. `sut_llm_proxy.py:275-287` saw status 200, set `decoded = None`, `read_usage(None) = (0, 0, 0)`, and
   `ACCOUNTANT.record(...)` — **one call billed**.
2. `memcog_driver.py` read that body, `json.loads` raised `JSONDecodeError`, and the retry loop re-sent the request
   twice more — **two more calls billed for the same logical call**.
3. The final error was `RuntimeError: the model call failed after three attempts: Expecting value: ...`, hiding both
   the overcharge and the body that caused it.

The red assertion — a billed malformed 200 must leave exactly one call in the accountant — failed at `1 == 3`.

## 3. The fix

`memcog_driver.py::_openai_compatible_call` now separates the two phases:

```python
try:
    with urllib.request.urlopen(request, timeout=...) as response:
        body = response.read().decode("utf-8")
except (urllib.error.HTTPError, urllib.error.URLError, OSError) as error:
    last_error = error
    time.sleep(2 * (attempt + 1))
    continue
try:
    return json.loads(body)
except json.JSONDecodeError as error:
    raise RuntimeError(f"the model returned a non-JSON response that was already billed: {body[:200]!r}") from error
```

- `HTTPError`/`URLError`/`OSError` remain retryable — the proxy records a failure, not a call, so a retry buys a
  real second chance at no double charge.
- `JSONDecodeError` is reported immediately with the first 200 bytes of the body, so a gateway that answers in HTML
  is diagnosable and the bill stays at one call.

The retry bound, backoff, and the rule that a body is returned unmodified are unchanged. Only the decision of *which*
failure is worth a second bill changed.

## 4. Acceptance

- `test_a_malformed_billed_200_is_reported_once_not_retried`: real proxy + real malformed upstream; asserts
  `ACCOUNTANT.snapshot()["calls"] == 1` and that the error names the already-billed response.
- `test_an_unbilled_transport_failure_is_still_retried`: a counting 503 upstream; asserts exactly three attempts,
  protecting the retry path from being removed with the decode branch.
- Full `pnpm check` and `pnpm test:tools` green; per-file coverage gate satisfied (both new branches exercised).

No API spend: both tests use local HTTP servers, no benchmark was dispatched.
