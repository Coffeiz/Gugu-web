from .runtime import serve


if __name__ == "__main__":
    from app.core.logging import setup_process_output

    setup_process_output()
    serve()
