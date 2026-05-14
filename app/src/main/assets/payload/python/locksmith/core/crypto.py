# -*- encoding: utf-8 -*-
"""
locksmith.core.crypto module

This module contains cryptographic utility functions.
"""
import base64

import pysodium


def stretch_password_to_passcode(password: str) -> str:
    """
    Stretch a user password of any length into a 22-character passcode
    suitable for KERI's Habery bran parameter.

    Uses Argon2id for memory-hard password hashing.

    Args:
        password: The user's password (any length).

    Returns:
        A 22-character Base64-encoded passcode.
    """
    # Application-specific salt (must match Archimedes for consistency)
    fixed_salt = b"NHCtv3Actrddf8jC"

    # Stretch using Argon2id
    stretched = pysodium.crypto_pwhash(
        outlen=16,
        passwd=password,
        salt=fixed_salt,
        opslimit=2,
        memlimit=67108864,  # 64 MB
        alg=pysodium.crypto_pwhash_ALG_ARGON2ID13,
    )

    # Encode to base64 (URL-safe, remove padding to get 22 chars)
    passcode_22 = base64.urlsafe_b64encode(stretched).decode().rstrip("=")

    return passcode_22
