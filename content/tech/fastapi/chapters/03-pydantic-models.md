# Pydantic Models, Validation, and Serialisation

FastAPI's model layer begins at the HTTP boundary. A request body is untrusted bytes, not a Python object; a response is a public contract, not a dump of internal state. Pydantic v2 models provide runtime parsing, validation, and serialisation when FastAPI uses them for request and response handling. Type annotations guide this process, but do not themselves validate arbitrary Python values.

## Models define boundary contracts

Define a `BaseModel` for a meaningful request or response shape. Field constraints and validators should express domain rules that can be checked locally, while database uniqueness, permissions, and multi-record invariants belong in service or persistence logic.

```python
from pydantic import BaseModel, ConfigDict, Field

class ProductCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    price: float = Field(gt=0, allow_inf_nan=False)
    tags: list[str] = Field(default_factory=list)
```

Pydantic v2 reads annotations and validates values when a model is constructed, usually coercing compatible inputs. `extra="forbid"` rejects unknown keys instead of silently ignoring them; it is a policy decision, not universally correct. For public write APIs, rejecting misspelled fields is often safer than quietly dropping them. Use `default_factory` for mutable values, just as in dataclasses.

A `field_validator` checks one field, while a `model_validator` can check the model as a whole. Validators should be deterministic and side-effect free. Do not query a database or call a remote service from a validator: validation may be invoked in contexts you do not expect, and external work belongs in an application service where latency and failure are explicit.

```python
from pydantic import BaseModel, model_validator

class DateRange(BaseModel):
    start: int
    end: int

    @model_validator(mode="after")
    def check_order(self):
        if self.end < self.start:
            raise ValueError("end must not precede start")
        return self
```

For reusable constraints on one field, use `Annotated` metadata and `Field`. Pydantic v2 also supports functional validators and serializers. Use them where they improve the domain model, but avoid clever transformations that make the accepted wire format hard to infer from the schema.

## Required, nullable, and default are distinct

In Pydantic v2, `field: str | None` is required but may be null; `field: str | None = None` is optional in the input because it has a default. `field: str = "x"` is not required and defaults to a string. This distinction is important for PATCH semantics: “not supplied” can mean leave unchanged, while explicit `null` can mean clear the value. A simple optional field alone does not preserve that distinction unless the application checks whether it was set, for example with `model_fields_set`.

Use versioned DTOs intentionally. A response model can evolve independently of ORM tables, and a request model can accept only safe writable fields. This prevents mass assignment—an attacker sending `is_admin: true` when a model is reused for database input—and allows the service layer to convert validated DTOs to domain objects.

## Request validation and error shape

FastAPI parses request data and asks Pydantic to validate it before calling the endpoint. A failure becomes a request validation error (normally HTTP 422), with structured details identifying locations and error types. Malformed JSON is a parsing failure; a valid JSON object with the wrong field type is a validation failure. Clients should treat error details as useful diagnostics but should not depend on every exact text string across library versions.

Body models improve OpenAPI generation. Constraints such as lengths, numeric bounds, enums, and descriptions inform the JSON Schema. A custom validator can enforce rules that do not map neatly to standard JSON Schema, so document those rules in field descriptions and examples as well.

## Response validation and serialisation

Use `response_model` to declare the public output shape. FastAPI validates returned data against it and serialises the permitted fields. This is a safety boundary: an internal ORM object may contain password hashes or private flags, but a response model can exclude them from the public representation. Return types can contribute schema information, but a clear `response_model` is often preferable when it differs from the endpoint's internal return type.

```python
from pydantic import BaseModel
from fastapi import FastAPI

class UserPublic(BaseModel):
    id: int
    email: str

@app.get("/users/{user_id}", response_model=UserPublic)
async def get_user(user_id: int):
    return {"id": user_id, "email": "sam@example.test", "password_hash": "never expose"}
```

FastAPI's response serialization uses Pydantic's v2 serialization machinery. Options such as `response_model_exclude_unset`, `response_model_exclude_none`, and `response_model_exclude_defaults` change output shape; use them only when the contract requires it. Returning a `Response` instance directly—such as `JSONResponse` or `StreamingResponse`—is an explicit low-level choice and bypasses parts of normal response-model processing. Validate data yourself if you take that path.

For custom scalar types, implement the Pydantic v2 core schema hooks only when necessary and test both validation and JSON Schema generation. Prefer built-in types (`EmailStr`, UUID, datetime, `Decimal`) and explicit serializers when they cover the domain. Avoid serialising binary, decimal, or timezone-sensitive values by accident; define a stable wire representation.

## ORM attributes and aliases

Pydantic models can be built from object attributes with `ConfigDict(from_attributes=True)`, useful for mapping ORM instances to response DTOs. The ORM object must have required attributes available; lazy relationship access during serialization can trigger extra queries or fail after the session closes. Load required relationships deliberately and avoid accidentally serialising an entire object graph.

Aliases bridge Python naming and an external API convention, such as `user_id` internally and `userId` externally. Configure validation and serialisation alias behavior intentionally; input acceptance and output alias emission are separate choices. Generated schemas should match actual JSON on the wire, so test representative payloads rather than relying on model declarations alone.

## Common mistakes

- Assuming annotations validate all runtime values. Validation occurs when Pydantic or FastAPI constructs/processes the model.
- Reusing one ORM-shaped model for both client input and public output.
- Confusing a required nullable field with an optional field that has a default.
- Performing database or network I/O in validators.
- Returning a raw `Response` and expecting `response_model` to filter its body.
- Depending on undocumented validator error text as a stable API contract.

## Production notes

Boundary models are versioned contracts. Keep database migrations and HTTP schema evolution separate, and add compatibility tests for clients that send old or partial payloads. For high-volume endpoints, profile before introducing custom serialization shortcuts: correctness and redaction are more important than a presumed micro-optimization. Test both the accepted inputs and the exact serialized response, including nulls, aliases, dates, and excluded fields. Pin Pydantic and FastAPI versions and review migration notes when upgrading because v1 configuration and validator APIs do not translate mechanically to v2.

## Strictness and coercion are policy choices

Pydantic commonly parses compatible input values rather than requiring every JSON type to match exactly. For example, an integer-like string may be accepted as an integer under the relevant validation mode. That convenience can be useful for query strings, which are text on the wire, but can also hide client mistakes in JSON. Decide whether strict validation is appropriate for each field and test the actual payloads clients send. Strictness should not be applied blindly to every model, because HTTP query parameters and JSON bodies have different representation constraints.

Use enums or `Literal` values for closed sets, and use discriminated unions when a payload has several clearly tagged variants. A discriminator improves validation and generated schema clarity compared with a broad union where multiple shapes overlap. For nested input, define size and cardinality limits where the application has resource constraints; validating a deeply nested structure still costs CPU and memory. Pydantic does not automatically impose an HTTP request-body size limit, so enforce that at the server or proxy boundary as well.

Serialization is not simply `json.dumps(model.__dict__)`. Pydantic v2's serializer understands declared types and supports field/model serializers. A custom serializer should produce a stable wire type and should be tested for both JSON output and schema accuracy. Decimal amounts, time zones, UUIDs, and bytes need an explicit representation agreed with clients. For sensitive fields, prefer not to include them in the public DTO at all rather than relying on ad hoc exclusion arguments that may be omitted by a future route.