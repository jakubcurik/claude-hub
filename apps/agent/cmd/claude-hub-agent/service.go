// SPDX-License-Identifier: Apache-2.0
package main

import (
	"fmt"

	"github.com/kardianos/service"
	"github.com/spf13/cobra"
)

type svcProgram struct{}

func (p *svcProgram) Start(_ service.Service) error { return nil }
func (p *svcProgram) Stop(_ service.Service) error  { return nil }

func newKardianosService() (service.Service, error) {
	return service.New(&svcProgram{}, &service.Config{
		Name:        "claude-hub-agent",
		DisplayName: "Claude Hub Agent",
		Description: "Local daemon that syncs ~/.claude/ with the Claude Hub server.",
		Arguments:   []string{"run"},
	})
}

func newServiceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the OS service (autostart at login)",
	}
	for _, action := range []string{"install", "uninstall", "start", "stop"} {
		a := action
		cmd.AddCommand(&cobra.Command{
			Use:   a,
			Short: fmt.Sprintf("%s the claude-hub-agent service", a),
			RunE: func(_ *cobra.Command, _ []string) error {
				s, err := newKardianosService()
				if err != nil {
					return err
				}
				return service.Control(s, a)
			},
		})
	}
	return cmd
}
