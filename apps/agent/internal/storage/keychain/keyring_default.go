// SPDX-License-Identifier: Apache-2.0
package keychain

import (
	"errors"

	"github.com/zalando/go-keyring"
)

type KeyringStore struct {
	Service string
}

func (k *KeyringStore) Set(key, value string) error {
	return keyring.Set(k.Service, key, value)
}

func (k *KeyringStore) Get(key string) (string, error) {
	v, err := keyring.Get(k.Service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNotFound
	}
	return v, err
}

func (k *KeyringStore) Delete(key string) error {
	err := keyring.Delete(k.Service, key)
	if errors.Is(err, keyring.ErrNotFound) {
		return ErrNotFound
	}
	return err
}
