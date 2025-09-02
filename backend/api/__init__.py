"""HTTP API layer (DRF views, serializers, URL map) for every endpoint in docs/API_CONTRACT.md. Owner: builder A.

Views call the domain core only through `<app>.api` modules and serialize the returned dataclasses with
`kinroot.contracts.to_wire`.
"""
