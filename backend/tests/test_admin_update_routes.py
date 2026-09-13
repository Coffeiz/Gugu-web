from app.main import app


ADMIN_UPDATE_ROUTES = {
    "/api/v1/admin/update/status": "get",
    "/api/v1/admin/update/check": "post",
    "/api/v1/admin/update/preflight": "post",
    "/api/v1/admin/update/start": "post",
    "/api/v1/admin/update/rollback/preflight": "post",
    "/api/v1/admin/update/rollback": "post",
}


def test_admin_update_routes_are_registered_and_require_bearer_auth():
    paths = app.openapi()["paths"]

    for path, method in ADMIN_UPDATE_ROUTES.items():
        operation = paths[path][method]
        assert {"HTTPBearer": []} in operation.get("security", [])
