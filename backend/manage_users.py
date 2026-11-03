"""Manage Face Enrollment operator accounts."""

import sys
from getpass import getpass

import auth


def show_help():
    print("""
Face Enrollment - User Management

Commands:
  python manage_users.py add USERNAME [NAME]
  python manage_users.py list
  python manage_users.py approve USERNAME
  python manage_users.py passwd USERNAME
  python manage_users.py disable USERNAME
  python manage_users.py enable USERNAME
  python manage_users.py delete USERNAME

Examples:
  python manage_users.py add zain "Zain Akram"
  python manage_users.py list
  python manage_users.py approve zain
  python manage_users.py disable zain
""")


def add_user(args):
    if len(args) < 1:
        print("Usage: python manage_users.py add USERNAME [NAME]")
        return

    username = args[0]
    name = " ".join(args[1:]) if len(args) > 1 else username

    password = getpass("New password: ")
    confirm = getpass("Confirm password: ")

    if password != confirm:
        print("ERROR: Passwords do not match.")
        return

    try:
        auth.create_user(username, name, password)
        print(f"SUCCESS: Account '{username}' created and activated.")
    except ValueError as exc:
        print(f"ERROR: {exc}")


def list_users():
    users = auth.list_users()

    if not users:
        print("No accounts found.")
        return

    print("\nOperator Accounts")
    print("-" * 75)
    print(f"{'USERNAME':20} {'NAME':25} {'STATUS':15} {'CREATED'}")
    print("-" * 75)

    for user in users:
        status = user.get("status")

        if not status:
            status = "active" if user.get("active") else "disabled"

        print(
            f"{user['username']:20} "
            f"{user['name'][:24]:25} "
            f"{status:15} "
            f"{user.get('created_at', '')}"
        )

    print("-" * 75)


def approve_user(args):
    if len(args) != 1:
        print("Usage: python manage_users.py approve USERNAME")
        return

    try:
        auth.approve_user(args[0])
        print(f"SUCCESS: Account '{args[0]}' approved.")
    except ValueError as exc:
        print(f"ERROR: {exc}")


def change_password(args):
    if len(args) != 1:
        print("Usage: python manage_users.py passwd USERNAME")
        return

    password = getpass("New password: ")
    confirm = getpass("Confirm password: ")

    if password != confirm:
        print("ERROR: Passwords do not match.")
        return

    try:
        auth.set_password(args[0], password)
        print(f"SUCCESS: Password updated for '{args[0]}'.")
    except ValueError as exc:
        print(f"ERROR: {exc}")


def disable_user(args):
    if len(args) != 1:
        print("Usage: python manage_users.py disable USERNAME")
        return

    try:
        auth.set_active(args[0], False)
        print(f"SUCCESS: Account '{args[0]}' disabled.")
    except ValueError as exc:
        print(f"ERROR: {exc}")


def enable_user(args):
    if len(args) != 1:
        print("Usage: python manage_users.py enable USERNAME")
        return

    try:
        auth.set_active(args[0], True)
        print(f"SUCCESS: Account '{args[0]}' enabled.")
    except ValueError as exc:
        print(f"ERROR: {exc}")


def delete_user(args):
    if len(args) != 1:
        print("Usage: python manage_users.py delete USERNAME")
        return

    username = args[0]
    confirm = input(
        f"Are you sure you want to delete '{username}'? (yes/no): "
    ).strip().lower()

    if confirm != "yes":
        print("Cancelled.")
        return

    try:
        auth.delete_user(username)
        print(f"SUCCESS: Account '{username}' deleted.")
    except ValueError as exc:
        print(f"ERROR: {exc}")


def main():
    if len(sys.argv) < 2:
        show_help()
        return

    command = sys.argv[1].lower()
    args = sys.argv[2:]

    commands = {
        "add": add_user,
        "list": lambda _: list_users(),
        "approve": approve_user,
        "passwd": change_password,
        "disable": disable_user,
        "enable": enable_user,
        "delete": delete_user,
    }

    action = commands.get(command)

    if action is None:
        show_help()
        return

    action(args)


if __name__ == "__main__":
    main()