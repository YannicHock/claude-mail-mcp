# Test-only TLS material

`localhost.crt` / `localhost.key` is a self-signed P-256 certificate for `localhost`, valid for 100 years. It is used only by `test/unit/lookup-reachability.test.ts`, which stands up a local `tls.Server` with it and hands the certificate to the reachability check as its trusted CA.

The key is public on purpose: it protects nothing and is never loaded outside the test suite. It was generated with:

```
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout localhost.key -out localhost.crt -days 36500 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"
```
